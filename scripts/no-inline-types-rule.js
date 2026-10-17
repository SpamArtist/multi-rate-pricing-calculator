import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import baseline from './inline-types-baseline.json' with { type: 'json' };

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Place new named types in dedicated type files' },
    messages: {
      separateType: 'Move {{name}} to a dedicated type file; put reusable domain types in src/shared/types/.',
    },
  },
  create(context) {
    const filename = relative(projectRoot, context.filename).replaceAll('\\', '/');
    if (filename.startsWith('src/shared/types/') || /\.types\.tsx?$/.test(filename)) return {};
    const existing = new Set(baseline[filename] ?? []);
    const check = node => {
      if (!existing.has(node.id.name)) {
        context.report({ node, messageId: 'separateType', data: { name: node.id.name } });
      }
    };
    return { TSTypeAliasDeclaration: check, TSInterfaceDeclaration: check };
  },
};
