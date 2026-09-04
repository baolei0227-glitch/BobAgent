/**
 * 分类目录树工具：在 markdown 中按主题层级（## 一级 / ### 二级 / #### 三级）组织条目。
 * 供待办/日程的内存渲染共用，保证分类结构一致。
 */

/**
 * 确保分类层级标题存在（不存在则创建），返回最后一个标题所在行号。
 * @param lines markdown 行数组（会被原地修改以创建缺失的标题）
 * @param categoryPath 主题层级，如 ["工作", "项目A"]
 */
export function ensureCategoryPath(lines: string[], categoryPath: string[]): number {
  let searchFromLine = 0;
  let depth = 0;

  for (const segment of categoryPath) {
    depth++;
    const prefix = '#'.repeat(depth + 1) + ' '; // ## for level1, ### for level2, #### for level3
    const heading = prefix + segment;

    // 在当前搜索范围内查找该标题
    let found = false;
    for (let i = searchFromLine; i < lines.length; i++) {
      if (lines[i].trim() === heading) {
        searchFromLine = i;
        found = true;
        break;
      }
    }

    if (!found) {
      // 需要创建该标题：找到同级标题的插入位置
      const headingLevel = depth + 1; // ## = 2, ### = 3, #### = 4

      // 找到该级别或更高级别的下一个标题
      let insertAt = lines.length - 1;
      for (let i = searchFromLine + 1; i < lines.length; i++) {
        const match = lines[i].match(/^(#{2,4})\s/);
        if (match && match[1].length <= headingLevel) {
          insertAt = i - 1;
          break;
        }
      }
      // 确保插入点之前有空行
      if (insertAt < lines.length - 1 && lines[insertAt].trim() !== '') {
        insertLines(lines, insertAt, ['']);
        insertAt++;
      }
      insertLines(lines, insertAt, [heading, '']);
      searchFromLine = insertAt + 2; // 跳过标题和空行
    }
  }

  // 找到该路径下最后一个条目的下一行（下一个同级/上级标题之前）
  let insertAfter = searchFromLine;
  const minLevel = categoryPath.length + 1; // 这个标题的 # 数量
  for (let i = searchFromLine + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{2,4})\s/);
    if (match && match[1].length <= minLevel) {
      break;
    }
    insertAfter = i;
  }
  return insertAfter;
}

/** 在指定行号之后插入若干行 */
export function insertLines(lines: string[], atLine: number, newLines: string[]) {
  lines.splice(atLine + 1, 0, ...newLines);
}
