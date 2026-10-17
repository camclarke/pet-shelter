/**
 * A SMALL DOM, just enough for React DOM's client renderer to mount the REAL
 * containers under node:test — review 4c-2 asked for tests on the container
 * (its initial state, its history, its guards, its photo lifecycle), not on a
 * fixture the test passes in. Not a test file itself (no `.test.`).
 *
 * There is no jsdom in this repo and nothing new is installed, so this is
 * deliberately narrow and honest about it:
 *   - elements, text, attributes, a tiny selector matcher (tag, #id, .class,
 *     [attr], [attr="v"], comma lists — no combinators);
 *   - events with capture, target and bubble phases, `preventDefault`;
 *   - focus as `document.activeElement`;
 *   - a history with real `pushState` / `replaceState` / `go`, whose `go`
 *     fires `popstate` asynchronously, as browsers do — and which records an
 *     attempt to go past either end instead of pretending it worked;
 *   - `location.assign` recorded, never performed;
 *   - a canvas whose `toBlob` returns a hand-built JPEG of the canvas's own
 *     size, and a `createImageBitmap` the test controls — so the REAL photo
 *     pipeline (`stripAndResize` → `inspectJpeg`) runs.
 * No layout, no CSS, no real input editing. A test drives it the way a person
 * would — set a value, dispatch the event — and reads the result back.
 *
 * Install it BEFORE importing react-dom: React decides whether it is in a
 * browser when its module loads.
 */

import { chromeLikeJpeg } from './jpeg-fixtures';

export const HTML_NS = 'http://www.w3.org/1999/xhtml';

type ListenerFn = (event: FakeEvent) => void;
interface Listener {
  fn: ListenerFn | { handleEvent: ListenerFn };
  capture: boolean;
  once: boolean;
}

export class FakeEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  target: FakeEventTarget | null = null;
  currentTarget: FakeEventTarget | null = null;
  eventPhase = 0;
  defaultPrevented = false;
  timeStamp = Date.now();
  isTrusted = true;
  button = 0;
  metaKey = false;
  ctrlKey = false;
  shiftKey = false;
  altKey = false;
  key = '';
  state: unknown = null;
  returnValue: unknown = true;
  stopped = false;
  stoppedImmediately = false;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    for (const [key, value] of Object.entries(init)) {
      if (key !== 'bubbles' && key !== 'cancelable') (this as Record<string, unknown>)[key] = value;
    }
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this.stopped = true;
  }
  stopImmediatePropagation() {
    this.stopped = true;
    this.stoppedImmediately = true;
  }
}

export class FakeEventTarget {
  private listeners = new Map<string, Listener[]>();

  addEventListener(type: string, fn: Listener['fn'] | null, options?: boolean | { capture?: boolean; once?: boolean }) {
    if (!fn) return;
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const once = typeof options === 'object' && Boolean(options?.once);
    const list = this.listeners.get(type) ?? [];
    if (!list.some((l) => l.fn === fn && l.capture === capture)) list.push({ fn, capture, once });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener['fn'] | null, options?: boolean | { capture?: boolean }) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((l) => !(l.fn === fn && l.capture === capture)));
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  /** The targets an event passes through above this one, nearest first. */
  protected eventParents(): FakeEventTarget[] {
    return [];
  }

  invoke(event: FakeEvent, phase: 'capture' | 'target' | 'bubble') {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      if (phase === 'capture' && !listener.capture) continue;
      if (phase === 'bubble' && listener.capture) continue;
      event.currentTarget = this;
      if (listener.once) this.removeEventListener(event.type, listener.fn, listener.capture);
      if (typeof listener.fn === 'function') listener.fn.call(this, event);
      else listener.fn.handleEvent(event);
      if (event.stoppedImmediately) return;
    }
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target = this;
    const parents = this.eventParents();
    event.eventPhase = 1;
    for (const node of [...parents].reverse()) {
      node.invoke(event, 'capture');
      if (event.stopped) break;
    }
    if (!event.stopped) {
      event.eventPhase = 2;
      this.invoke(event, 'target');
    }
    if (event.bubbles && !event.stopped) {
      event.eventPhase = 3;
      for (const node of parents) {
        node.invoke(event, 'bubble');
        if (event.stopped) break;
      }
    }
    event.eventPhase = 0;
    event.currentTarget = null;
    return !event.defaultPrevented;
  }
}

export class FakeNode extends FakeEventTarget {
  nodeType = 0;
  nodeName = '';
  nodeValue: string | null = null;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  ownerDocument: FakeDocument;

  constructor(ownerDocument: FakeDocument) {
    super();
    this.ownerDocument = ownerDocument;
  }

  protected eventParents(): FakeEventTarget[] {
    const out: FakeEventTarget[] = [];
    for (let n = this.parentNode; n; n = n.parentNode) out.push(n);
    const root = out[out.length - 1] ?? this;
    if (root instanceof FakeDocument && root.defaultView) out.push(root.defaultView);
    return out;
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) + 1] ?? null) : null;
  }
  get previousSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    return siblings ? (siblings[siblings.indexOf(this) - 1] ?? null) : null;
  }
  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n.parentNode) n = n.parentNode;
    return n instanceof FakeDocument;
  }

  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }

  insertBefore<T extends FakeNode>(child: T, ref: FakeNode | null): T {
    if (child.nodeType === 11) {
      for (const c of [...child.childNodes]) this.insertBefore(c, ref);
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    if (ref === null) this.childNodes.push(child);
    else {
      const at = this.childNodes.indexOf(ref);
      if (at < 0) throw new Error('insertBefore: the reference is not a child');
      this.childNodes.splice(at, 0, child);
    }
    child.parentNode = this;
    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild<T extends FakeNode>(child: FakeNode, old: T): T {
    this.insertBefore(child, old);
    return this.removeChild(old);
  }

  hasChildNodes() {
    return this.childNodes.length > 0;
  }

  contains(other: FakeNode | null): boolean {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  getRootNode(): FakeNode {
    let n: FakeNode = this;
    while (n.parentNode) n = n.parentNode;
    return n;
  }

  get textContent(): string {
    if (this.nodeType === 3 || this.nodeType === 8) return this.nodeValue ?? '';
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value: string | null) {
    if (this.nodeType === 3 || this.nodeType === 8) {
      this.nodeValue = value ?? '';
      return;
    }
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
}

export class FakeText extends FakeNode {
  constructor(doc: FakeDocument, text: string, comment = false) {
    super(doc);
    this.nodeType = comment ? 8 : 3;
    this.nodeName = comment ? '#comment' : '#text';
    this.nodeValue = text;
  }
  get data() {
    return this.nodeValue ?? '';
  }
  set data(value: string) {
    this.nodeValue = value;
  }
}

class FakeStyle {
  [key: string]: unknown;
  setProperty(name: string, value: string) {
    this[name] = value;
  }
  removeProperty(name: string) {
    delete this[name];
  }
}

// ── a tiny selector matcher ─────────────────────────────────────────────────

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
}

function parseCompound(selector: string): Compound {
  const out: Compound = { tag: null, id: null, classes: [], attrs: [] };
  let rest = selector.trim();
  const tag = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tag) {
    out.tag = tag[0].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    let m: RegExpExecArray | null;
    if ((m = /^#([\w-]+)/.exec(rest))) out.id = m[1]!;
    else if ((m = /^\.([\w-]+)/.exec(rest))) out.classes.push(m[1]!);
    else if ((m = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/.exec(rest))) {
      out.attrs.push({ name: m[1]!.toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? null });
    } else throw new Error(`fake-dom: unsupported selector «${selector}»`);
    rest = rest.slice(m[0].length);
  }
  return out;
}

function matchesCompound(element: FakeElement, c: Compound): boolean {
  if (c.tag && element.localName !== c.tag) return false;
  if (c.id && element.getAttribute('id') !== c.id) return false;
  const classes = (element.getAttribute('class') ?? '').split(/\s+/);
  if (c.classes.some((name) => !classes.includes(name))) return false;
  for (const attr of c.attrs) {
    const own = element.getAttribute(attr.name);
    // React keeps `type` and `name` as properties on inputs: read those too.
    const value = own ?? ((element as unknown as Record<string, unknown>)[attr.name] as string | undefined) ?? null;
    if (value === null || value === undefined) return false;
    if (attr.value !== null && String(value) !== attr.value) return false;
  }
  return true;
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  return selector.split(',').some((part) => {
    if (/\s/.test(part.trim())) throw new Error(`fake-dom: combinators are not supported («${part.trim()}»)`);
    return matchesCompound(element, parseCompound(part));
  });
}

function descendants(node: FakeNode): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of node.childNodes) {
    if (child instanceof FakeElement) out.push(child, ...descendants(child));
  }
  return out;
}

export class FakeElement extends FakeNode {
  tagName: string;
  localName: string;
  namespaceURI: string;
  private attributeMap = new Map<string, string>();
  style = new FakeStyle();
  onclick: unknown = null;
  scrollTop = 0;
  scrollLeft = 0;
  [key: string]: unknown;

  constructor(doc: FakeDocument, tag: string, namespace: string) {
    super(doc);
    this.nodeType = 1;
    this.localName = tag.toLowerCase();
    this.tagName = namespace === HTML_NS ? tag.toUpperCase() : tag;
    this.nodeName = this.tagName;
    this.namespaceURI = namespace;
    if (this.localName === 'input' || this.localName === 'textarea') {
      this.value = '';
      this.selectionStart = 0;
      this.selectionEnd = 0;
    }
  }

  setAttribute(name: string, value: unknown) {
    this.attributeMap.set(name.toLowerCase(), String(value));
  }
  setAttributeNS(_ns: string | null, name: string, value: unknown) {
    this.setAttribute(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributeMap.get(name.toLowerCase()) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributeMap.has(name.toLowerCase());
  }
  removeAttribute(name: string) {
    this.attributeMap.delete(name.toLowerCase());
  }
  removeAttributeNS(_ns: string | null, name: string) {
    this.removeAttribute(name);
  }

  get id() {
    return this.getAttribute('id') ?? '';
  }
  set id(value: string) {
    this.setAttribute('id', value);
  }
  get className() {
    return this.getAttribute('class') ?? '';
  }
  set className(value: string) {
    this.setAttribute('class', value);
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }

  focus() {
    if (this.hasAttribute('disabled')) return;
    this.ownerDocument.activeElement = this;
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  click() {
    this.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true }));
  }
  scrollIntoView() {}
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }
  closest(selector: string): FakeElement | null {
    for (let n: FakeNode | null = this; n instanceof FakeElement; n = n.parentNode) {
      if (n.matches(selector)) return n;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return descendants(this).filter((e) => e.matches(selector));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** Width and height in, JPEG bytes out — what the canvas "encodes". */
export type CanvasEncoder = (width: number, height: number) => Uint8Array;

class FakeCanvas extends FakeElement {
  width = 300;
  height = 150;
  constructor(doc: FakeDocument) {
    super(doc, 'canvas', HTML_NS);
  }
  getContext() {
    return { drawImage() {} };
  }
  toBlob(callback: (blob: Blob | null) => void) {
    const bytes = this.ownerDocument.encodeCanvas(this.width, this.height);
    setTimeout(() => callback(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })), 0);
  }
}

export class FakeDocument extends FakeNode {
  documentElement: FakeElement;
  head: FakeElement;
  body: FakeElement;
  activeElement: FakeElement;
  defaultView: FakeWindow | null = null;
  encodeCanvas: CanvasEncoder = (width, height) => chromeLikeJpeg({ width, height });
  // React asks `'oninput' in document` to decide how it listens for typing.
  oninput: unknown = null;
  onchange: unknown = null;
  onclick: unknown = null;

  constructor() {
    // The node constructor needs the document it belongs to: itself.
    super(undefined as unknown as FakeDocument);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.nodeName = '#document';
    this.documentElement = new FakeElement(this, 'html', HTML_NS);
    this.head = new FakeElement(this, 'head', HTML_NS);
    this.body = new FakeElement(this, 'body', HTML_NS);
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag: string): FakeElement {
    return tag.toLowerCase() === 'canvas' ? new FakeCanvas(this) : new FakeElement(this, tag, HTML_NS);
  }
  createElementNS(namespace: string, tag: string): FakeElement {
    return new FakeElement(this, tag, namespace);
  }
  createTextNode(text: string) {
    return new FakeText(this, text);
  }
  createComment(text: string) {
    return new FakeText(this, text, true);
  }
  getElementById(id: string): FakeElement | null {
    return descendants(this).find((e) => e.getAttribute('id') === id) ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    return descendants(this).filter((e) => e.matches(selector));
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeLocation {
  private url: URL;
  /** Every `assign()` — a full page load the fake never performs. */
  assigned: string[] = [];
  constructor(href: string) {
    this.url = new URL(href);
  }
  set(href: string) {
    this.url = new URL(href, this.url);
  }
  get href() {
    return this.url.href;
  }
  get origin() {
    return this.url.origin;
  }
  get protocol() {
    return this.url.protocol;
  }
  get host() {
    return this.url.host;
  }
  get hostname() {
    return this.url.hostname;
  }
  get pathname() {
    return this.url.pathname;
  }
  get search() {
    return this.url.search;
  }
  get hash() {
    return this.url.hash;
  }
  assign(href: string) {
    this.assigned.push(new URL(href, this.url).href);
  }
  replace(href: string) {
    this.assigned.push(new URL(href, this.url).href);
  }
  toString() {
    return this.href;
  }
}

export interface HistoryEntry {
  state: unknown;
  url: string;
}

export class FakeHistory {
  entries: HistoryEntry[];
  index = 0;
  /** `go(delta)` calls that would have left either end of the history. */
  outOfRange: number[] = [];
  constructor(private win: FakeWindow, href: string, before: string[] = []) {
    this.entries = [...before.map((url) => ({ state: null, url: new URL(url, href).href })), { state: null, url: href }];
    this.index = this.entries.length - 1;
  }
  get state() {
    return this.entries[this.index]?.state ?? null;
  }
  get length() {
    return this.entries.length;
  }
  get current(): HistoryEntry {
    return this.entries[this.index]!;
  }
  pushState(state: unknown, _title: string, url?: string) {
    const href = new URL(url ?? this.current.url, this.current.url).href;
    this.entries.splice(this.index + 1);
    this.entries.push({ state, url: href });
    this.index = this.entries.length - 1;
    this.win.location.set(href);
  }
  replaceState(state: unknown, _title: string, url?: string) {
    const href = new URL(url ?? this.current.url, this.current.url).href;
    this.entries[this.index] = { state, url: href };
    this.win.location.set(href);
  }
  back() {
    this.go(-1);
  }
  forward() {
    this.go(1);
  }
  /** As in a browser: the traversal, then `popstate`, in a later task. */
  go(delta: number) {
    setTimeout(() => {
      const target = this.index + delta;
      if (delta === 0 || target < 0 || target >= this.entries.length) {
        this.outOfRange.push(delta);
        return;
      }
      this.index = target;
      this.win.location.set(this.current.url);
      this.win.dispatchEvent(new FakeEvent('popstate', { state: this.current.state }));
    }, 0);
  }
  /** The `?paso=` of every entry, `-` for one without (the guard, another page). */
  steps(): string[] {
    return this.entries.map((e) => new URL(e.url).searchParams.get('paso') ?? `-${new URL(e.url).pathname}`);
  }
}

export class FakeWindow extends FakeEventTarget {
  document: FakeDocument;
  location: FakeLocation;
  history: FakeHistory;
  navigator = { userAgent: 'node-fake-dom', language: 'es-BO' };
  event: unknown = undefined;
  self: FakeWindow;
  top: FakeWindow;
  window: FakeWindow;
  HTMLIFrameElement = class HTMLIFrameElement {};
  HTMLElement = FakeElement;
  Element = FakeElement;
  Node = FakeNode;
  Event = FakeEvent;
  setTimeout = globalThis.setTimeout.bind(globalThis);
  clearTimeout = globalThis.clearTimeout.bind(globalThis);
  scrolls = 0;

  constructor(href: string, before: string[] = []) {
    super();
    this.document = new FakeDocument();
    this.document.defaultView = this;
    this.location = new FakeLocation(href);
    this.history = new FakeHistory(this, href, before);
    this.self = this;
    this.top = this;
    this.window = this;
  }
  scrollTo() {
    this.scrolls += 1;
  }
  getSelection() {
    return null;
  }
  getComputedStyle() {
    return { getPropertyValue: () => '' };
  }
  requestAnimationFrame(callback: (time: number) => void) {
    return setTimeout(() => callback(Date.now()), 0);
  }
  cancelAnimationFrame(id: ReturnType<typeof setTimeout>) {
    clearTimeout(id);
  }
}

/** What the photo pipeline's browser half reads: an image bitmap of a given size. */
export interface BitmapSource {
  width: number;
  height: number;
  unreadable?: boolean;
}

export interface Installed {
  window: FakeWindow;
  document: FakeDocument;
  /** Set what `createImageBitmap` decodes next (default 4000 × 3000). */
  nextBitmap: BitmapSource;
  created: string[];
  revoked: string[];
}

/**
 * Put the fake on `globalThis` — window, document, self, navigator, the
 * element classes React checks against, `createImageBitmap`, and spied
 * `URL.createObjectURL` / `revokeObjectURL` — and switch React's act
 * environment on. `before` lists the pages already in the tab's history.
 */
export function installFakeDom(href: string, before: string[] = []): Installed {
  const win = new FakeWindow(href, before);
  const installed: Installed = {
    window: win,
    document: win.document,
    nextBitmap: { width: 4000, height: 3000 },
    created: [],
    revoked: [],
  };
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define('window', win);
  define('document', win.document);
  define('self', win);
  define('navigator', win.navigator);
  define('HTMLElement', FakeElement);
  define('HTMLIFrameElement', win.HTMLIFrameElement);
  define('Element', FakeElement);
  define('Node', FakeNode);
  define('requestAnimationFrame', win.requestAnimationFrame.bind(win));
  define('cancelAnimationFrame', win.cancelAnimationFrame.bind(win));
  define('IS_REACT_ACT_ENVIRONMENT', true);
  define('createImageBitmap', async () => {
    const source = installed.nextBitmap;
    if (source.unreadable) throw new Error('InvalidStateError: the source image could not be decoded');
    return { width: source.width, height: source.height, close() {} };
  });
  let n = 0;
  URL.createObjectURL = () => {
    const url = `blob:fake/${(n += 1)}`;
    installed.created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    installed.revoked.push(url);
  };
  return installed;
}

// ── driving it the way a person would ──────────────────────────────────────

export function textOf(node: FakeNode): string {
  return node.textContent.replace(/\s+/g, ' ').trim();
}

/** Every element matching `selector` whose text contains `text`. */
export function findAll(root: FakeNode, selector: string, text?: string | RegExp): FakeElement[] {
  const all = root instanceof FakeDocument ? root.querySelectorAll(selector) : (root as FakeElement).querySelectorAll(selector);
  if (text === undefined) return all;
  return all.filter((e) => (typeof text === 'string' ? textOf(e).includes(text) : text.test(textOf(e))));
}

export function find(root: FakeNode, selector: string, text?: string | RegExp): FakeElement {
  const [found] = findAll(root, selector, text);
  if (!found) throw new Error(`fake-dom: nothing matches ${selector}${text ? ` «${String(text)}»` : ''}`);
  return found;
}

export function click(element: FakeElement) {
  element.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

export function type(element: FakeElement, value: string) {
  element.value = value;
  element.dispatchEvent(new FakeEvent('input', { bubbles: true }));
}

export function check(element: FakeElement, checked = true) {
  element.checked = checked;
  element.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

export function chooseFile(input: FakeElement, file: Blob) {
  input.files = [file];
  input.dispatchEvent(new FakeEvent('change', { bubbles: true }));
}
