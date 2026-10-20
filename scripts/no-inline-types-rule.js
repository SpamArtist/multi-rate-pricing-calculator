import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Place new named types in dedicated type files' },
    messages: {
      separateType: 'Move {{name}} to a dedicated type file; put shared types in src/shared/types/.',
    },
  },
  create(context) {
    const filename = relative(projectRoot, context.filename).replaceAll('\\', '/');
    if (filename.startsWith('src/shared/types/') || /\.types\.tsx?$/.test(filename)) return {};
    const check = node => {
      context.report({ node, messageId: 'separateType', data: { name: node.id.name } });
    };
    return { TSTypeAliasDeclaration: check, TSInterfaceDeclaration: check };
  },
};
