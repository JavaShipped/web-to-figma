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

  it('turns an uneven gap (margin-left: auto) into leading space on a wrapper', () => {
    const a = el(rect(0, 0, 100, 40));
    const b = el(rect(132, 0, 100, 40));
    const c = el(rect(900, 0, 100, 40));
    const row = el(rect(0, 0, 1000, 40), { display: 'flex', columnGap: 32 }, [a, b, c]);
    const plan = planLayouts(row).get(row.id)!;

    expect(plan.itemSpacing).toBe(32);
    expect(plan.children[2].wrapper?.padStart).toBe(636);
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
    expect(plan.grid!.uniformColumns).toBe(true);
    expect(plan.grid!.cells[4]).toMatchObject({ row: 1, col: 1, rowSpan: 1, colSpan: 1 });
    expect(plan.children.every((c) => c.sizingH === 'FILL')).toBe(true);
    expect(plan.canHugH).toBe(false);
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
