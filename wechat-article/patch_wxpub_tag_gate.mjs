#!/usr/bin/env node
/**
 * 重新应用「标签校准闸门」到 wechat-article-workflow skill。
 *
 * skill 目录不在项目 git 里，升级/重装后 lib/pipeline.mjs 会被覆盖，
 * 本补丁用于恢复钩子。幂等：重复运行不会重复插入。
 *
 * 用法：node wechat-article/patch_wxpub_tag_gate.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PIPELINE = '/root/.codebuddy/skills/wechat-article-workflow/lib/pipeline.mjs';

let src = readFileSync(PIPELINE, 'utf-8');

const importLine = "import { execFileSync } from 'node:child_process';\n";
const hookBlock = `
  // 标签校准闸门（可选）：确保文章帮账号打准「A股投研」标签，避免无关内容稀释标签。
  // 由 .wxpub/.env 的 WXPUB_TAG_CHECK 指定 python 钩子绝对路径；未配置则跳过。
  const tagCheck = (values.WXPUB_TAG_CHECK || '').trim();
  if (tagCheck && existsSync(tagCheck)) {
    log.step('标签校准检查');
    try {
      const out = execFileSync(tagCheck, [join(pkg.dir, 'article.md')], {
        encoding: 'utf-8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      log.plain(out.trimEnd());
      log.ok('标签校准通过');
    } catch (err) {
      const detail = \`\${err.stdout || ''}\${err.stderr || ''}\`.trim();
      if (detail) log.plain(detail);
      throw new PipelineError('标签校准未通过，已阻止发布。见上方阻断项。', { stage: 'tag-calibration' });
    }
  }
`;

let changed = false;

if (!src.includes("import { execFileSync } from 'node:child_process';")) {
  src = src.replace(
    "import { basename, join, relative, resolve } from 'node:path';",
    "import { basename, join, relative, resolve } from 'node:path';\n" + importLine.trimEnd(),
  );
  changed = true;
  console.log('已插入 execFileSync import');
}

if (!src.includes('标签校准闸门')) {
  const anchor = "  log.ok(`当日包校验通过：${pkg.dir}`);";
  if (!src.includes(anchor)) {
    console.error('找不到锚点，无法插入钩子。请手动检查 pipeline.mjs。');
    process.exit(1);
  }
  src = src.replace(anchor, anchor + '\n' + hookBlock);
  changed = true;
  console.log('已插入标签校准钩子');
}

if (changed) {
  writeFileSync(PIPELINE, src);
  console.log('补丁已写入：' + PIPELINE);
} else {
  console.log('钩子已存在，无需改动（幂等）');
}
