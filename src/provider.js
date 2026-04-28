import { logger } from './utils.js';

/**
 * Provider adapter: handles API format conversion between OpenAI and Anthropic
 */

/**
 * Convert OpenAI request to provider-specific format
 */
export function convertRequest(provider, originalBody) {
  const body = { ...originalBody };

  if (provider.apiType === 'anthropic-messages') {
    return convertOpenAIToAnthropic(provider, body);
  }

  // OpenAI-compatible: override model, keep everything else
  body.model = provider.model;
  return { url: `${provider.baseUrl}/chat/completions`, body };
}

/**
 * Convert provider-specific response to OpenAI format
 */
function stripThinkingTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function convertResponse(provider, data) {
  if (provider.apiType === 'anthropic-messages') {
    return convertAnthropicToOpenAI(data);
  }
  // OpenAI-compatible: strip thinking tags and reasoning_content
  if (data.choices && Array.isArray(data.choices)) {
    data = JSON.parse(JSON.stringify(data));
    for (const choice of data.choices) {
      // Strip reasoning_content (thinking field used by xiaomi, etc.)
      if (choice.message) {
        delete choice.message.reasoning_content;
        if (choice.message.content) {
          choice.message.content = stripThinkingTags(choice.message.content);
        }
      }
      if (choice.delta) {
        delete choice.delta.reasoning_content;
        if (choice.delta.content) {
          choice.delta.content = stripThinkingTags(choice.delta.content);
        }
      }
    }
  }
  return data;
}

/**
 * Build provider-specific headers
 */
export function buildHeaders(provider) {
  if (provider.apiType === 'anthropic-messages') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.apiKey}`,
  };
}

// --- OpenAI → Anthropic ---

function convertOpenAIToAnthropic(provider, body) {
  const anthropicBody = {
    model: provider.model,
    max_tokens: body.max_tokens || 16384,
    // Disable extended thinking so <thinking> tags don't appear in output
    thinking: { type: 'disabled' },
  };

  // Extract system message
  const messages = body.messages || [];
  const systemMsgs = messages.filter(m => m.role === 'system');
  const nonSystemMsgs = messages.filter(m => m.role !== 'system');

  if (systemMsgs.length > 0) {
    anthropicBody.system = systemMsgs.map(m => m.content).join('\n\n');
  }

  // Convert messages (merge consecutive same-role messages)
  anthropicBody.messages = mergeConsecutiveMessages(nonSystemMsgs);

  // Convert tools
  if (body.tools) {
    anthropicBody.tools = body.tools.map(t => ({
      name: t.function.name,
      description: t.function.description || '',
      input_schema: t.function.parameters || { type: 'object', properties: {} },
    }));
  }

  if (body.tool_choice) {
    anthropicBody.tool_choice = convertToolChoice(body.tool_choice);
  }

  if (body.temperature !== undefined) anthropicBody.temperature = body.temperature;
  if (body.top_p !== undefined) anthropicBody.top_p = body.top_p;
  if (body.stop) anthropicBody.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  return { url: `${provider.baseUrl}/messages`, body: anthropicBody };
}

function mergeConsecutiveMessages(messages) {
  const merged = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      // Merge content
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content = last.content + '\n\n' + msg.content;
      } else if (Array.isArray(last.content) && Array.isArray(msg.content)) {
        last.content = [...last.content, ...msg.content];
      } else {
        merged.push(msg);
      }
    } else {
      // Convert tool result messages to Anthropic format
      if (msg.role === 'tool') {
        merged.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === 'assistant' && msg.tool_calls) {
        // Convert tool_calls to Anthropic content blocks
        const content = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || '{}'),
          });
        }
        merged.push({ role: 'assistant', content });
      } else {
        merged.push(msg);
      }
    }
  }
  return merged;
}

function convertToolChoice(toolChoice) {
  if (toolChoice === 'auto' || toolChoice === 'none') return toolChoice;
  if (toolChoice === 'required') return { type: 'any' };
  if (toolChoice?.function?.name) {
    return { type: 'tool', name: toolChoice.function.name };
  }
  return toolChoice;
}

// --- Anthropic → OpenAI ---

function convertAnthropicToOpenAI(data) {
  const content = data.content || [];
  let textContent = '';
  const toolCalls = [];

  for (const block of content) {
    if (block.type === 'text') {
      textContent += stripThinkingTags(block.text);
    } else if (block.type === 'thinking') {
      // skip thinking blocks entirely
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      });
    }
  }

  let finishReason = 'stop';
  if (data.stop_reason === 'tool_use') finishReason = 'tool_calls';
  else if (data.stop_reason === 'max_tokens') finishReason = 'length';

  const openaiResponse = {
    id: data.id ? data.id.replace('msg_', 'chatcmpl-') : 'chatcmpl-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data.model || 'unknown',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: data.usage?.input_tokens || 0,
      completion_tokens: data.usage?.output_tokens || 0,
      total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    },
  };

  return openaiResponse;
}

/**
 * Build provider URL for streaming
 */
export function buildRequestUrl(provider) {
  if (provider.apiType === 'anthropic-messages') {
    return `${provider.baseUrl}/messages`;
  }
  return `${provider.baseUrl}/chat/completions`;
}
