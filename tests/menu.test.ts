// メニューの項目：どの項目にも絵の作り方があり、どのグループも見出しで全部の項目をおおう
import { describe, expect, it } from 'vitest';
import { TOOL_GROUPS, allItems, metaLine, thumbKey } from '../src/ui/menu';
import { MENU_ICON_IDS } from '../src/ui/menuIcons';
import { CIVIC, CivicId } from '../src/sim/defs';

describe('menu', () => {
  it('every group with a sub-menu is split into headed sections covering all its items', () => {
    for (const g of TOOL_GROUPS) {
      if (g.tool) {
        expect(g.sections, g.id).toBeUndefined();
        continue;
      }
      expect(g.sections?.length, g.id).toBeGreaterThan(0);
      for (const s of g.sections!) {
        expect(s.title.trim().length, `${g.id} heading`).toBeGreaterThan(0);
        expect(s.items.length, `${g.id}/${s.title}`).toBeGreaterThan(0);
      }
      // ツールの重複なし（同じ項目が2つの見出しに出ない）
      const tools = allItems(g).map((i) => i.tool);
      expect(new Set(tools).size, g.id).toBe(tools.length);
    }
  });

  it('every item has a thumbnail spec; every plop item renders its own building', () => {
    for (const g of TOOL_GROUPS)
      for (const it of allItems(g)) {
        expect(it.thumb, it.tool).toBeDefined();
        if (it.thumb.k === 'icon') expect(MENU_ICON_IDS, it.tool).toContain(it.thumb.icon);
        if (it.tool.startsWith('plop:')) {
          const id = it.tool.slice(5) as CivicId;
          expect(CIVIC[id], it.tool).toBeDefined();
          expect(it.thumb, it.tool).toEqual({ k: 'civic', id });
        }
        expect(thumbKey(it.thumb).length).toBeGreaterThan(0);
      }
  });

  it('every placeable civic building is in the menu', () => {
    const inMenu = new Set(TOOL_GROUPS.flatMap((g) => allItems(g)).map((i) => i.tool));
    for (const id of Object.keys(CIVIC)) {
      if (id === 'busstop') continue; // バス停は道路をタップして置く（busstop ツール）
      expect(inMenu.has(`plop:${id}`), id).toBe(true);
    }
  });

  it('shows cost, upkeep and size, and no size baked into names', () => {
    const items = TOOL_GROUPS.flatMap((g) => allItems(g));
    const police = items.find((i) => i.tool === 'plop:police_l')!;
    expect(metaLine(police)).toBe(`§${(5000).toLocaleString()} ・ 維持 §260/月 ・ 3×2`);
    const road = items.find((i) => i.tool === 'road:2')!;
    expect(metaLine(road)).toBe('§20/マス ・ 維持 §0.2/マス/月');
    for (const it of items) expect(it.name, it.tool).not.toMatch(/\d+×\d+/);
    // 記念施設は、建てられる条件も出す
    for (const it of items.filter((i) => i.tool.startsWith('plop:') && CIVIC[i.tool.slice(5) as CivicId].reward)) expect(it.req, it.tool).toBeTruthy();
  });
});
