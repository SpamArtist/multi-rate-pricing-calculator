export default {
  meta: {
    type: 'suggestion',
    languages: ['css/css'],
    schema: [{ type: 'integer', minimum: 0 }],
    messages: {
      exceeded: 'File has too many lines ({{actual}}). Maximum allowed is {{max}}.',
    },
  },
  create(context) {
    const max = context.options[0];
    const lines = context.sourceCode.text.split(/\r\n|[\r\n\f]/u);
    const actual = lines.length - (lines.at(-1) === '' ? 1 : 0);

    return {
      StyleSheet() {
        if (actual <= max) return;
        context.report({
          loc: { line: max + 1, column: 1 },
          messageId: 'exceeded',
          data: { actual, max },
        });
      },
    };
  },
};
