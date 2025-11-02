import prettier from 'prettier';

/**
 * Format markdown content with Prettier.
 */
export async function formatMarkdown(content: string): Promise<string> {
  try {
    return await prettier.format(content, {
      parser: 'markdown',
      semi: true,
      singleQuote: true,
      trailingComma: 'es5',
      printWidth: 100,
      tabWidth: 2,
    });
  } catch (error) {
    console.warn('Prettier formatting failed, returning unformatted content:', error);
    return content;
  }
}
