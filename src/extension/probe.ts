// Runs in the page's own JS world (content scripts can't see framework internals). Finds the
// components that render each DOM element in React and Vue dev builds and writes them onto the
// element as data-w2f-* attributes, which the capture script reads and then removes.
//
// Production builds minify component names, so those are skipped; data-component / data-slot
// attributes still work there.

const MAX_PROPS = 12;

const INTERNAL =
  /^(Provider|Consumer|Context|Suspense|Fragment|StrictMode|Profiler|Portal|Slot|Slottable|Primitive.*|Presence|ForwardRef|Memo|Anonymous|Unknown)$|(Provider|Boundary|Router|Handler|Context|Template|Reload|DevTools|Overlay|Root)$/;

function goodName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 2 && /^[A-Z]/.test(name) && !INTERNAL.test(name) && !name.includes('$');
}

function primitiveProps(props: Record<string, unknown> | null | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props) return out;
  let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (n >= MAX_PROPS) break;
    if (k === 'children' || k === 'className' || k === 'style' || k === 'class' || k.startsWith('on')) continue;
    if (typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 40)) {
      out[k] = v;
      n++;
    }
  }
  return out;
}

function mark(el: Element, chain: { name: string; props: Record<string, unknown> }[], source: 'react' | 'vue') {
  const outer = chain[chain.length - 1];
  el.setAttribute('data-w2f-component', outer.name);
  el.setAttribute('data-w2f-chain', chain.map((c) => c.name).join('>'));
  el.setAttribute('data-w2f-props', JSON.stringify(primitiveProps(outer.props)));
  el.setAttribute('data-w2f-source', source);
}

// ---------- React ----------

interface Fiber {
  tag: number;
  type: unknown;
  stateNode: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: Record<string, unknown> | null;
}

const HOST_COMPONENT = 5;
const HOST_TEXT = 6;
const HOST_PORTAL = 4;
const HOST_ROOT = 3;

function reactName(type: unknown): string | null {
  if (!type) return null;
  if (typeof type === 'function') {
    const t = type as { displayName?: string; name?: string };
    return t.displayName ?? t.name ?? null;
  }
  if (typeof type === 'object') {
    const t = type as { displayName?: string; render?: unknown; type?: unknown };
    if (t.displayName) return t.displayName;
    if (t.render) return reactName(t.render); // forwardRef
    if (t.type) return reactName(t.type); // memo
  }
  return null;
}

/** The single host (DOM) fiber a composite fiber renders, or null if it renders several or none. */
function singleHostRoot(fiber: Fiber): Fiber | null {
  const found: Fiber[] = [];
  const walk = (f: Fiber | null) => {
    for (let c = f?.child ?? null; c && found.length < 2; c = c.sibling) {
      if (c.tag === HOST_COMPONENT || c.tag === HOST_TEXT) found.push(c);
      else if (c.tag !== HOST_PORTAL) walk(c);
    }
  };
  walk(fiber);
  return found.length === 1 ? found[0] : null;
}

function probeReact(els: Element[]): number {
  let key: string | undefined;
  let count = 0;
  for (const el of els) {
    if (!key) key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (!key) continue;
    const host = (el as unknown as Record<string, Fiber | undefined>)[key];
    if (!host) continue;
    const chain: { name: string; props: Record<string, unknown> }[] = [];
    for (let f = host.return; f && f.tag !== HOST_ROOT && f.tag !== HOST_COMPONENT; f = f.return) {
      const root = singleHostRoot(f);
      if (!root || root.stateNode !== el) break;
      const name = reactName(f.type);
      if (goodName(name)) chain.push({ name, props: f.memoizedProps ?? {} });
    }
    if (chain.length) {
      mark(el, chain, 'react');
      count++;
    }
  }
  return count;
}

// ---------- Vue 3 ----------

interface VueInstance {
  type: { name?: string; __name?: string };
  props: Record<string, unknown>;
  subTree: { el: unknown };
  parent: VueInstance | null;
}

function probeVue(els: Element[]): number {
  let count = 0;
  for (const el of els) {
    let inst = (el as unknown as { __vueParentComponent?: VueInstance }).__vueParentComponent;
    const chain: { name: string; props: Record<string, unknown> }[] = [];
    while (inst && inst.subTree?.el === el) {
      const name = inst.type?.name ?? inst.type?.__name;
      if (goodName(name)) chain.push({ name, props: inst.props });
      inst = inst.parent ?? undefined;
    }
    if (chain.length) {
      mark(el, chain, 'vue');
      count++;
    }
  }
  return count;
}

(() => {
  const els = Array.from(document.querySelectorAll('body *'));
  const react = probeReact(els);
  const vue = react ? 0 : probeVue(els);
  (window as unknown as { __w2fProbe?: unknown }).__w2fProbe = { react, vue };
})();
