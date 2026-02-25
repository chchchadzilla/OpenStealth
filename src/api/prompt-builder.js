/*
 * OpenStealth — Prompt Builder
 * Constructs intelligent prompts based on page context, user interactions,
 * and conversation history.
 */

export class PromptBuilder {
  constructor(settings = {}) {
    this.settings = settings;
    this.systemPrompt = settings.systemPrompt || this.defaultSystemPrompt();
  }

  defaultSystemPrompt() {
    return `You are OpenStealth, a privacy-focused AI assistant embedded in the user's browser sidebar. 

Your role:
- Analyze page content, images, and user context to provide helpful information
- When the user focuses on a specific element (question, image, input field), provide relevant information about that element
- If you see a question being displayed, provide a clear, accurate answer
- If you see educational content or a slideshow, summarize key points and provide additional context
- Be concise but thorough — the user is viewing this in a sidebar
- Format your responses with markdown for readability
- If you can determine the user's intent from their interaction (clicking an answer box, highlighting text, focusing an input), tailor your response accordingly

Important:
- Never mention that you're an AI assistant or extension in your responses if the user hasn't explicitly asked
- Respond naturally as if you're a knowledgeable companion
- If you see a question with answer choices, indicate which is correct and briefly explain why
- If content is in an image, describe what you see and provide relevant analysis`;
  }

  /**
   * Build a prompt from a detected page change
   */
  buildFromChange(context) {
    const parts = [];

    // Describe what changed
    parts.push(`[Page Change Detected: ${context.description}]`);

    // If there's an active slide, include it
    if (context.activeSlide) {
      parts.push(`\n--- Current Slide Content ---\n${context.activeSlide.text}`);
    }

    // Include page text context
    if (context.pageText) {
      parts.push(`\n--- Visible Page Content ---\n${context.pageText.substring(0, 3000)}`);
    }

    // Include user interaction context
    if (context.userInteraction) {
      parts.push(this._formatInteraction(context.userInteraction));
    }

    // Build the actual query
    parts.push('\n--- Your Task ---');
    parts.push('Based on the page content above, provide relevant information, answers, or analysis. ' +
               'If there are questions visible, answer them. If there is educational content, summarize key points. ' +
               'If there are images, describe what you observe.');

    return parts.join('\n');
  }

  /**
   * Build a prompt from a user's direct query
   */
  buildFromQuery(query, pageContext) {
    const parts = [];

    if (pageContext) {
      parts.push('--- Current Page Context ---');
      if (pageContext.meta?.title) parts.push(`Page: ${pageContext.meta.title}`);
      if (pageContext.meta?.url) parts.push(`URL: ${pageContext.meta.url}`);
      if (pageContext.activeSlide) {
        parts.push(`Active Slide: ${pageContext.activeSlide.text?.substring(0, 500)}`);
      }
      if (pageContext.interaction) {
        parts.push(this._formatInteraction(pageContext.interaction));
      }
      if (pageContext.text) {
        parts.push(`\nPage Content:\n${pageContext.text.substring(0, 3000)}`);
      }
      parts.push('---\n');
    }

    parts.push(`User Query: ${query}`);
    return parts.join('\n');
  }

  /**
   * Format user interaction context
   */
  _formatInteraction(interaction) {
    if (!interaction) return '';

    const parts = ['\n--- User Interaction ---'];

    switch (interaction.type) {
      case 'selection':
        parts.push(`User selected text: "${interaction.text}"`);
        break;
      case 'click':
        parts.push(`User clicked on: ${this._describeElement(interaction.elementInfo)}`);
        break;
      case 'focus':
        parts.push(`User focused on input: ${this._describeElement(interaction.elementInfo)}`);
        if (interaction.elementInfo?.nearbyQuestion) {
          parts.push(`Nearby question: "${interaction.elementInfo.nearbyQuestion}"`);
        }
        break;
      case 'typing':
        parts.push(`User is typing in: ${this._describeElement(interaction.elementInfo)}`);
        if (interaction.text) parts.push(`Current input: "${interaction.text}"`);
        if (interaction.elementInfo?.nearbyQuestion) {
          parts.push(`Question being answered: "${interaction.elementInfo.nearbyQuestion}"`);
        }
        break;
      case 'hover':
        parts.push(`User is examining: ${this._describeElement(interaction.elementInfo)}`);
        break;
    }

    return parts.join('\n');
  }

  /**
   * Describe an element in natural language
   */
  _describeElement(info) {
    if (!info) return 'unknown element';

    const parts = [];

    if (info.tag === 'img') {
      parts.push(`an image${info.alt ? ` (alt: "${info.alt}")` : ''}`);
      if (info.src) parts.push(`[src: ${info.src.substring(0, 100)}]`);
    } else if (info.isInput || info.isEditable) {
      parts.push(`${info.tag} input field`);
      if (info.label) parts.push(`labeled "${info.label}"`);
      if (info.placeholder) parts.push(`(placeholder: "${info.placeholder}")`);
    } else {
      parts.push(`<${info.tag}>`);
      if (info.textContent) {
        parts.push(`containing: "${info.textContent.substring(0, 200)}"`);
      }
    }

    if (info.role) parts.push(`[role="${info.role}"]`);

    return parts.join(' ');
  }

  /**
   * Build the full messages array for the API call
   */
  buildMessages(prompt, conversationHistory = [], imageData = null, pageContext = null) {
    const messages = [];

    // System prompt
    messages.push({
      role: 'system',
      content: this.systemPrompt,
    });

    // Include relevant conversation history (last N turns)
    const recentHistory = conversationHistory.slice(-10);
    messages.push(...recentHistory);

    // Build the user message
    if (imageData) {
      // Vision message with image
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: pageContext ? this.buildFromQuery(prompt, pageContext) : prompt,
          },
          {
            type: 'image_url',
            image_url: {
              url: imageData,
              detail: 'high',
            },
          },
        ],
      });
    } else {
      messages.push({
        role: 'user',
        content: pageContext ? this.buildFromQuery(prompt, pageContext) : prompt,
      });
    }

    return messages;
  }
}
