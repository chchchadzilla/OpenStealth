/*
 * OpenStealth — OpenRouter API Client
 * Handles all LLM API calls through OpenRouter with streaming support,
 * vision capabilities, and tool call handling.
 */

export class OpenRouterAPI {
  constructor(apiKey, settings = {}) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://openrouter.ai/api/v1';
    this.model = settings.model || 'google/gemini-2.0-flash-001';
    this.visionModel = settings.visionModel || 'google/gemini-2.0-flash-001';
    this.maxTokens = settings.maxTokens || 4096;
    this.temperature = settings.temperature ?? 0.7;
    this.enableToolCalls = settings.enableToolCalls || false;
  }

  /**
   * Send a chat completion request with optional streaming
   */
  async chat(messages, options = {}) {
    const {
      stream = false,
      onToken = null,
      model = null,
      tools = null,
    } = options;

    // Determine if we need the vision model
    const hasImages = messages.some(m => 
      Array.isArray(m.content) && m.content.some(c => c.type === 'image_url')
    );
    const useModel = model || (hasImages ? this.visionModel : this.model);

    const body = {
      model: useModel,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream,
    };

    // Add tools if enabled and provided
    if (this.enableToolCalls && tools?.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      // Anonymized — don't leak extension identity in API traffic
      'HTTP-Referer': 'https://openrouter.ai',
      'X-Title': 'Browser Assistant',
    };

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`OpenRouter API error (${response.status}): ${errBody}`);
      }

      if (stream && onToken) {
        return await this._handleStream(response, onToken);
      } else {
        const data = await response.json();
        return this._parseResponse(data);
      }
    } catch (err) {
      console.error('[OpenStealth] API call failed:', err);
      throw err;
    }
  }

  /**
   * Handle streaming response
   */
  async _handleStream(response, onToken) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let toolCalls = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const data = JSON.parse(trimmed.slice(6));
            const delta = data.choices?.[0]?.delta;

            if (delta?.content) {
              fullContent += delta.content;
              onToken(delta.content);
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!toolCalls[tc.index]) {
                  toolCalls[tc.index] = {
                    id: tc.id || '',
                    type: 'function',
                    function: { name: '', arguments: '' },
                  };
                }
                if (tc.function?.name) {
                  toolCalls[tc.index].function.name += tc.function.name;
                }
                if (tc.function?.arguments) {
                  toolCalls[tc.index].function.arguments += tc.function.arguments;
                }
              }
            }
          } catch (e) {
            // Malformed SSE line, skip
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Parse tool call arguments
    toolCalls = toolCalls.filter(Boolean).map(tc => {
      try {
        tc.function.arguments = JSON.parse(tc.function.arguments);
      } catch (e) {
        // Leave as string if not valid JSON
      }
      return tc;
    });

    return { content: fullContent, toolCalls };
  }

  /**
   * Parse non-streaming response
   */
  _parseResponse(data) {
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('No response from model');
    }

    return {
      content: choice.message?.content || '',
      toolCalls: choice.message?.tool_calls || [],
      finishReason: choice.finish_reason,
      usage: data.usage,
    };
  }

  /**
   * List available models from OpenRouter
   */
  async listModels() {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
      },
    });
    if (!response.ok) throw new Error(`Failed to list models: ${response.status}`);
    const data = await response.json();
    return data.data || [];
  }

  /**
   * Get models with vision capability
   */
  async getVisionModels() {
    const models = await this.listModels();
    return models.filter(m => 
      m.architecture?.modality?.includes('image') ||
      m.id.includes('vision') ||
      m.id.includes('gemini') ||
      m.id.includes('gpt-4o') ||
      m.id.includes('claude-3')
    );
  }

  /**
   * Get default tool definitions for browser control
   */
  static getDefaultTools() {
    return [
      {
        type: 'function',
        function: {
          name: 'type_text',
          description: 'Type text into a form field or input element on the page with human-like typing behavior',
          parameters: {
            type: 'object',
            properties: {
              selector: {
                type: 'string',
                description: 'CSS selector for the target input element',
              },
              text: {
                type: 'string',
                description: 'The text to type',
              },
            },
            required: ['selector', 'text'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'click_element',
          description: 'Click on an element on the page with human-like mouse movement',
          parameters: {
            type: 'object',
            properties: {
              selector: {
                type: 'string',
                description: 'CSS selector for the element to click',
              },
            },
            required: ['selector'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_web',
          description: 'Search the web for information',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query',
              },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_page_content',
          description: 'Read the full text content of the current page',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
    ];
  }
}
