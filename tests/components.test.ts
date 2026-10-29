import { describe, expect, it } from 'vitest';
import { detectComponents } from '../src/shared/components';
import { planLayouts } from '../src/shared/layout';
import type { ComponentRef, ElementNode } from '../src/shared/schema';
import { el, rect, text } from './helpers';

const ref = (name: string, props: ComponentRef['props'] = {}): ComponentRef => ({ name, chain: [name], props, source: 'attr' });

function card(x: number, className = 'card'): ElementNode {
  return el(rect(x, 0, 200, 120), { display: 'flex', flexDirection: 'column', rowGap: 8, padding: [16, 16, 16, 16] }, [
    text(rect(x + 16, 16, 168, 24), 1, 'Title'),
    text(rect(x + 16, 48, 168, 40), 2, 'Body'),
  ], { className });
}

describe('detectComponents', () => {
  it('groups framework components by name with variant axes from props', () => {
    const btn = (x: number, variant: string) =>
      el(rect(x, 0, 100, 36), { display: 'flex', padding: [0, 14, 0, 14] }, [text(rect(x + 14, 6, 72, 24), 1, 'Go')], {
        component: ref('Button', { variant, size: 'sm' }),
      });
    const root = el(rect(0, 0, 400, 36), { display: 'flex' }, [btn(0, 'default'), btn(120, 'outline'), btn(240, 'default')]);
    const sets = detectComponents(root, planLayouts(root));

    expect(sets).toHaveLength(1);
    expect(sets[0].name).toBe('Button');
    expect(sets[0].axes).toEqual(['variant']); // size is constant, so not an axis
    expect(sets[0].variants.map((v) => [v.props.variant, v.nodeIds.length])).toEqual([
      ['default', 2],
      ['outline', 1],
    ]);
  });

  it('makes a component from a structure repeated with the same classes', () => {
    const root = el(rect(0, 0, 700, 120), { display: 'flex', columnGap: 20 }, [card(0), card(220), card(440)]);
    const sets = detectComponents(root, planLayouts(root));
    expect(sets).toHaveLength(1);
    expect(sets[0].source).toBe('structure');
    expect(sets[0].variants[0].nodeIds).toHaveLength(3);
  });

  it('ignores structures that differ in classes or appear once', () => {
    const root = el(rect(0, 0, 700, 120), { display: 'flex', columnGap: 20 }, [card(0), card(220, 'card featured')]);
    expect(detectComponents(root, planLayouts(root))).toHaveLength(0);
  });

  it('orders inner components before the components that contain them', () => {
    const inner = (x: number) => el(rect(x, 0, 50, 20), {}, [text(rect(x, 0, 50, 20))], { component: ref('Chip') });
    const outer = (x: number) => el(rect(x, 0, 100, 20), { display: 'flex' }, [inner(x)], { component: ref('Row') });
    const root = el(rect(0, 0, 300, 20), { display: 'flex' }, [outer(0), outer(150)]);
    expect(detectComponents(root, planLayouts(root)).map((s) => s.name)).toEqual(['Chip', 'Row']);
  });
});
