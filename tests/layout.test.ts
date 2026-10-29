import { describe, expect, it } from 'vitest';
import { planLayouts } from '../src/shared/layout';
import { el, rect, text } from './helpers';

describe('planLayouts', () => {
  it('stacks block children vertically with uniform spacing and fill widths', () => {
    const h2 = text(rect(24, 24, 752, 40));
    const p = text(rect(24, 80, 752, 48), 2);
    const div = el(rect(24, 144, 752, 100), {}, [text(rect(24, 144, 300, 24))]);
    const section = el(rect(0, 0, 800, 268), { padding: [24, 24, 24, 24] }, [h2, p, div]);
    const plan = planLayouts(section).get(section.id)!;

    expect(plan.mode).toBe('VERTICAL');
    expect(plan.itemSpacing).toBe(16);
    expect(plan.padding).toEqual([24, 24, 24, 24]);
    expect(plan.canHugV).toBe(true);
    expect(plan.children.map((c) => c.sizingH)).toEqual(['FILL', 'FILL', 'FILL']);
    expect(plan.children[0].sizingV).toBe('HUG');
    expect(plan.children.every((c) => !c.wrapper)).toBe(true);
  });

  it('maps a flex row: gap, cross-axis centring and hugging items', () => {
    const a = el(rect(24, 20, 80, 24), { display: 'flex' }, [text(rect(24, 20, 80, 24))]);
    const b = el(rect(136, 14, 120, 36), { display: 'flex' }, [text(rect(136, 20, 80, 24))]);
    const nav = el(rect(0, 0, 1000, 64), { display: 'flex', alignItems: 'center', columnGap: 32, padding: [0, 24, 0, 24] }, [a, b]);
    const plan = planLayouts(nav).get(nav.id)!;

    expect(plan.mode).toBe('HORIZONTAL');
    expect(plan.counterAlign).toBe('CENTER');
    expect(plan.itemSpacing).toBe(32);
    expect(plan.padding[3]).toBe(24);
    expect(plan.children.map((c) => c.sizingH)).toEqual(['HUG', 'FIXED']);
  });

  it('turns margin-left: auto into a filling wrapper that pushes the item to the end', () => {
    const a = el(rect(0, 0, 100, 40));
    const b = el(rect(132, 0, 100, 40));
    const c = el(rect(900, 0, 100, 40));
    const row = el(rect(0, 0, 1000, 40), { display: 'flex', columnGap: 32 }, [a, b, c]);
    const plan = planLayouts(row).get(row.id)!;

    expect(plan.itemSpacing).toBe(32);
    expect(plan.children[2].wrapper).toMatchObject({ push: true, padStart: 0, sizingH: 'FILL' });
    expect(plan.canHugH).toBe(false);
  });

  it('keeps an uneven gap as leading space when nothing is pushed to the end', () => {
    const a = el(rect(0, 0, 100, 40));
    const b = el(rect(132, 0, 100, 40));
    const c = el(rect(300, 0, 100, 40));
    const row = el(rect(0, 0, 1000, 40), { display: 'flex', columnGap: 32 }, [a, b, c]);
    const plan = planLayouts(row).get(row.id)!;
    expect(plan.children[2].wrapper).toMatchObject({ push: false, padStart: 36 });
  });

  it('centres a max-width container inside a full-width section', () => {
    const inner = el(rect(60, 0, 1080, 500), {}, [el(rect(60, 0, 1080, 500))]);
    const section = el(rect(0, 0, 1200, 500), {}, [inner]);
    const plan = planLayouts(section).get(section.id)!;

    expect(plan.mode).toBe('VERTICAL');
    expect(plan.counterAlign).toBe('CENTER');
    expect(plan.children[0].sizingH).toBe('FIXED');
    expect(plan.children[0].wrapper).toBeNull();
  });

  it('maps CSS grid onto grid cells', () => {
    const cards = [0, 1, 2, 3, 4, 5].map((i) => el(rect((i % 3) * 320, Math.floor(i / 3) * 220, 300, 200)));
    const grid = el(rect(0, 0, 940, 420), { display: 'grid', gridColumns: [300, 300, 300], gridRows: [200, 200], columnGap: 20, rowGap: 20 }, cards);
    const plan = planLayouts(grid).get(grid.id)!;

    expect(plan.grid).not.toBeNull();
    expect(plan.grid!.columns.map((c) => [c.type, c.value])).toEqual([['FLEX', 1], ['FLEX', 1], ['FLEX', 1]]);
    expect(plan.grid!.cells[4]).toMatchObject({ row: 1, col: 1, rowSpan: 1, colSpan: 1 });
    expect(plan.children.every((c) => c.sizingH === 'FILL')).toBe(true);
    expect(plan.canHugH).toBe(false);
  });

  it('places a full-width spanning grid item even when reported row sizes disagree', () => {
    const heading = el(rect(0, 0, 486, 361));
    const list = el(rect(606, 0, 594, 435));
    const ledger = el(rect(0, 539, 1200, 74)); // grid-column: 1 / -1
    const grid = el(rect(0, 0, 1200, 613), { display: 'grid', gridColumns: [486, 594], gridRows: [435, 58], columnGap: 120, rowGap: 120 }, [heading, list, ledger]);
    const plan = planLayouts(grid).get(grid.id)!;

    expect(plan.grid).not.toBeNull();
    expect(plan.grid!.cells[2]).toMatchObject({ row: 1, col: 0, colSpan: 2 });
    expect(plan.grid!.rowGap).toBe(104);
  });

  it('maps 1fr auto 1fr with an end-aligned item to flex / hug / flex tracks', () => {
    const logo = el(rect(0, 0, 120, 44), { display: 'flex' }, [text(rect(0, 10, 120, 24))]);
    const links = el(rect(482, 0, 236, 44), { display: 'flex' }, [text(rect(482, 10, 236, 24))]);
    const actions = el(rect(1040, 0, 160, 44), { display: 'flex' }, [text(rect(1040, 10, 160, 24))]);
    const nav = el(rect(0, 0, 1200, 44), { display: 'grid', gridColumns: [454, 236, 454], gridRows: [44], columnGap: 28 }, [logo, links, actions]);
    const g = planLayouts(nav).get(nav.id)!.grid!;
    expect(g.columns.map((c) => c.type)).toEqual(['FLEX', 'HUG', 'FLEX']);
    expect([g.cells[0].alignH, g.cells[2].alignH]).toEqual(['MIN', 'MAX']);
  });

  it('never lets a wrapping row hug its width', () => {
    const items = [0, 1, 2].map((i) => el(rect(i * 110, Math.floor(i / 2) * 50, 100, 40)));
    const row = el(rect(0, 0, 210, 90), { display: 'flex', flexWrap: true, columnGap: 10, rowGap: 10 }, items);
    const plan = planLayouts(row).get(row.id)!;
    expect(plan.wrap).toBe(true);
    expect(plan.canHugH).toBe(false);
  });

  it('does not let items fill an auto (hug) grid column', () => {
    const copy = el(rect(0, 0, 800, 60), {}, [text(rect(0, 0, 800, 60), 2)]);
    const action = el(rect(856, 0, 294, 60), { display: 'flex', flexDirection: 'column', alignItems: 'center' }, [
      el(rect(856, 0, 294, 40), { display: 'flex', justifyContent: 'center', alignItems: 'center', padding: [8, 20, 8, 20] }, [text(rect(890, 10, 226, 20))]),
      text(rect(856, 44, 294, 16)),
    ]);
    const cta = el(rect(0, 0, 1150, 60), { display: 'grid', gridColumns: [800, 294], gridRows: [60], columnGap: 56 }, [copy, action]);
    const plan = planLayouts(cta).get(cta.id)!;
    expect(plan.grid!.columns.map((c) => c.type)).toEqual(['FLEX', 'HUG']);
    expect(plan.children[1].sizingH).toBe('HUG');
  });

  it('breaks MIN/CENTER ties with the container alignment instead of adding a wrapper', () => {
    const t = text(rect(16, 9.3, 60, 18)); // 1.3px from the top and centred: both within tolerance
    const button = el(rect(0, 0, 92, 36), { display: 'flex', alignItems: 'center', padding: [8, 16, 8, 16] }, [t]);
    const plan = planLayouts(button).get(button.id)!;
    expect(plan.counterAlign).toBe('CENTER');
    expect(plan.children[0].wrapper).toBeNull();
  });

  it('keeps absolutely positioned children out of the flow and stacks them by z-index', () => {
    const body = text(rect(0, 0, 200, 24));
    const badge = el(rect(150, -10, 40, 20), { position: 'absolute', zIndex: 2 });
    const backdrop = el(rect(0, 0, 200, 24), { position: 'absolute', zIndex: -1 });
    const card = el(rect(0, 0, 200, 24), { position: 'relative' }, [body, badge, backdrop]);
    const plan = planLayouts(card).get(card.id)!;

    expect(plan.mode).toBe('VERTICAL');
    expect(plan.children[1].absolute).toBe(true);
    expect(plan.order).toEqual([2, 0, 1]);
  });

  it('never lets a child fill an axis its parent hugs', () => {
    const t = text(rect(16, 8, 60, 20));
    const button = el(rect(0, 0, 92, 36), { display: 'flex', alignItems: 'center', padding: [8, 16, 8, 16] }, [t]);
    const row = el(rect(0, 0, 400, 36), { display: 'flex' }, [button]);
    const plans = planLayouts(row);
    expect(plans.get(row.id)!.children[0].sizingH).toBe('HUG');
    expect(plans.get(button.id)!.children[0].sizingH).toBe('HUG');
  });

  it('falls back to no auto layout when children overlap', () => {
    const a = el(rect(0, 0, 100, 100));
    const b = el(rect(10, 10, 100, 100));
    const box = el(rect(0, 0, 120, 120), {}, [a, b]);
    expect(planLayouts(box).get(box.id)!.mode).toBe('NONE');
  });
});
