import { logger } from './utils.js';
import { generateId } from './utils.js';

/**
 * SSE streaming utilities
 */

/**
 * Write SSE event to response
 */
function writeSSE(res, data) {
  if (res.writableEnded) return false;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

/**
 * Write SSE done marker
 */
function writeDone(res) {
  if (res.writableEnded) return;
  res.write('data: [DONE]\n\n');
}

/**
 * Read lines from a ReadableStream (for SSE parsing)
 */
async function* readLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop(); // Keep incomplete line in buffer

    for (const line of lines) {
      yield line;
    }
  }

  if (buffer) {
    yield buffer;
  }
}

/**
 * Parse SSE events from an OpenAI-compatible stream
 */
async function* parseOpenAIStream(response) {
  for await (const line of readLines(response.body)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') return;
    try {
      const chunk = JSON.parse(data);
      // Strip thinking tags and reasoning_content from delta
      if (chunk.choices) {
        for (const choice of chunk.choices) {
          if (choice.delta) {
            delete choice.delta.reasoning_content;
            if (choice.delta.content) {
              choice.delta.content = stripThinkingTags(choice.delta.content);
            }
          }
        }
      }
      yield chunk;
    } catch {
      // skip malformed JSON
    }
  }
}

/**
 * Strip <thinking> tags from text content
 */
function stripThinkingTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * Parse SSE events from an Anthropic stream and convert to OpenAI format
 */
async function* parseAnthropicStream(response) {
  let chatId = generateId('chatcmpl');
  let model = '';
  let sentFirstChunk = false;

  for await (const line of readLines(response.body)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);

    try {
      const event = JSON.parse(data);

      switch (event.type) {
        case 'message_start': {
          chatId = event.message?.id
            ? event.message.id.replace('msg_', 'chatcmpl-')
            : chatId;
          model = event.message?.model || '';
          // First chunk with role
          yield {
            id: chatId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          };
          sentFirstChunk = true;
          break;
        }

        case 'content_block_start': {
          // Skip thinking blocks entirely
          if (event.content_block?.type === 'thinking') break;
          if (event.content_block?.type === 'tool_use') {
            yield {
              id: chatId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: event.index || 0,
                        id: event.content_block.id,
                        type: 'function',
                        function: { name: event.content_block.name, arguments: '' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
          }
          break;
        }

        case 'content_block_delta': {
          // Skip thinking deltas
          if (event.delta?.type === 'thinking_delta') break;
          if (event.delta?.type === 'text_delta') {
            const cleanText = stripThinkingTags(event.delta.text);
            if (cleanText) {
              yield {
                id: chatId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  { index: 0, delta: { content: cleanText }, finish_reason: null },
                ],
              };
            }
          } else if (event.delta?.type === 'input_json_delta') {
            yield {
              id: chatId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: event.index || 0,
                        function: { arguments: event.delta.partial_json },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
          }
          break;
        }

        case 'message_delta': {
          let finishReason = 'stop';
          if (event.delta?.stop_reason === 'tool_use') finishReason = 'tool_calls';
          else if (event.delta?.stop_reason === 'max_tokens') finishReason = 'length';

          const usage = event.usage
            ? {
                prompt_tokens: event.usage.input_tokens || 0,
                completion_tokens: event.usage.output_tokens || 0,
                total_tokens:
                  (event.usage.input_tokens || 0) + (event.usage.output_tokens || 0),
              }
            : undefined;

          yield {
            id: chatId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            ...(usage ? { usage } : {}),
          };
          break;
        }

        case 'message_stop':
          // End of stream
          return;

        case 'error': {
          logger.error('Anthropic stream error:', event.error);
          return;
        }

        default:
          break;
      }
    } catch {
      // skip malformed JSON
    }
  }
}

/**
 * Stream a provider's SSE response to the client response.
 * Returns { success: true } if stream completed normally,
 * or { success: false, error } if stream failed.
 */
export async function streamProviderToClient(provider, fetchResponse, res) {
  try {
    let chunks;
    let tokensIn = 0;
    let tokensOut = 0;

    if (provider.apiType === 'anthropic-messages') {
      chunks = parseAnthropicStream(fetchResponse);
    } else {
      chunks = parseOpenAIStream(fetchResponse);
    }

    for await (const chunk of chunks) {
      // Capture usage from stream chunks
      if (chunk.usage) {
        tokensIn = chunk.usage.prompt_tokens || tokensIn;
        tokensOut = chunk.usage.completion_tokens || tokensOut;
      }
      if (!writeSSE(res, chunk)) {
        return { success: false, error: new Error('Client disconnected'), tokensIn, tokensOut };
      }
    }

    writeDone(res);
    return { success: true, tokensIn, tokensOut };
  } catch (err) {
    logger.error(`[${provider.name}] Stream error:`, err.message);
    return { success: false, error: err };
  }
}

/**
 * Read a complete (non-streaming) response from a provider.
 * Returns parsed JSON, converted to OpenAI format.
 */
export async function readCompleteResponse(provider, fetchResponse) {
  const text = await fetchResponse.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${provider.name}: ${text.slice(0, 200)}`);
  }
}

export { writeSSE, writeDone, parseOpenAIStream, parseAnthropicStream };
