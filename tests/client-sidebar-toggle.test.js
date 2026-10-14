/**
 * Regression tests for the "show in sidebar" preference.
 *
 * The plugin client is a plain `window.__ModuleLoader__.load({ id, factory })` call,
 * so it can be exercised outside a browser: we provide minimal react/document/
 * localStorage stand-ins and a fake Cordis client context, then assert the exact
 * thing the sidebar shell observes — its live `sidebar.panellist` entry list
 * (SidebarRegistry.syncPanels() reads precisely this).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const PREF_KEY = 'dsh-skillhub:sidebar-panellist'

/**
 * React stand-in. Function components expand eagerly so the settings tree is fully
 * resolved; checkboxes found anywhere in the tree are recorded in `captured`.
 */
function createReact(captured) {
  return {
    createElement(type, props, ...children) {
      if (props && props.type === 'checkbox' && typeof props.onChange === 'function') captured.checkbox = props
      if (typeof type === 'function') return type({ ...(props || {}), children })
      return { type, props, children }
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  }
}

/** Map-backed localStorage stand-in. */
function mapStorage(map = new Map()) {
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

/**
 * Load lib/client.js the way the web shell does and return { plugin, captured }.
 * @param storage - localStorage stand-in, shared across simulated page loads.
 */
function loadPlugin(storage) {
  const captured = { checkbox: null }
  const react = createReact(captured)
  const win = {
    __ModuleLoader__: { load(spec) { win.spec = spec } },
    localStorage: storage,
  }
  const documentStub = { head: { appendChild() {} }, createElement: () => ({ remove() {} }) }
  const source = readFileSync(CLIENT_PATH, 'utf8')
  new Function('window', 'globalThis', 'document', 'require', source)(win, globalThis, documentStub, (id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require(${id})`)
  })

  assert.ok(win.spec, 'lib/client.js must call window.__ModuleLoader__.load')
  assert.equal(win.spec.id, 'dsh-skillhub')
  return { plugin: win.spec.factory((id) => {
    if (id === 'react') return react
    throw new Error(`unexpected require(${id})`)
  }), captured }
}

/** Fake client context exposing only what the plugin touches. */
function createContext() {
  const entries = []
  const injections = new Map()
  const ledger = { registered: 0, disposed: 0 }
  const slots = {
    inject(key, callback) {
      injections.set(key, callback)
      return () => {}
    },
    register(options, component) {
      const isSidebar = options.name === 'sidebar.panellist'
      if (isSidebar) ledger.registered += 1
      const entry = { options, component, disposed: false }
      entry.dispose = () => {
        if (entry.disposed) return
        entry.disposed = true
        if (isSidebar) ledger.disposed += 1
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }
      entries.push(entry)
      return entry.dispose
    },
    /** Mirrors the sidebar shell's panel projection. */
    entriesOfSlot(name) {
      return entries.filter((entry) => entry.options.name === name).map((entry) => ({ options: entry.options }))
    },
  }
  return {
    ctx: {
      effect: (fn) => {
        const disposer = fn()
        return () => disposer?.()
      },
      slots,
      locale: { register: () => () => {}, bind: (ns) => (key) => `${ns}:${key}`, subscribe: () => () => {} },
      layout: { selectPanel() {}, toggleSidebar() {} },
    },
    injections,
    entries,
    ledger,
    panelIds: () => slots.entriesOfSlot('sidebar.panellist').map((entry) => entry.options.id),
    settingsEntry: () => entries.find((entry) => entry.options.name === 'settings.section'),
  }
}

/**
 * Boot the plugin against a fresh context and wire up both slot injections.
 * @returns the context, with the captured settings checkbox exposed.
 */
function boot(storage) {
  const { plugin, captured } = loadPlugin(storage)
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'layout'])
  const env = createContext()
  plugin.apply(env.ctx)
  assert.ok(env.injections.has('sidebar.panellist'), 'apply() must inject sidebar.panellist')
  assert.ok(env.injections.has('settings.section'), 'apply() must inject settings.section')
  env.disposeSidebar = env.injections.get('sidebar.panellist')()
  env.injections.get('settings.section')()
  return { env, plugin, captured }
}

test('the sidebar entry is shown by default', () => {
  const storage = mapStorage()
  const { env } = boot(storage)
  assert.deepEqual(env.panelIds(), ['skillhub'])
  assert.equal(storage.map.get(PREF_KEY), undefined, 'no preference is written before the first toggle')
})

test('the settings page renders one labelled switch reflecting the current preference', () => {
  const storage = mapStorage()
  const { env, captured } = boot(storage)
  env.settingsEntry().component({ t: (key) => key })
  assert.ok(captured.checkbox, 'settings page must render a switch checkbox')
  assert.equal(captured.checkbox.checked, true)
  assert.equal(captured.checkbox['aria-label'], 'sidebarShow')
})

test('toggling the switch off removes the sidebar entry, and back on restores it', () => {
  const storage = mapStorage()
  const { env, captured } = boot(storage)
  env.settingsEntry().component({ t: (key) => key })
  const { onChange } = captured.checkbox

  onChange({ target: { checked: false } })
  assert.equal(storage.map.get(PREF_KEY), '0', 'preference persisted as 0')
  assert.deepEqual(env.panelIds(), [], 'sidebar row disappears when the switch is off')
  assert.equal(env.ledger.disposed, 1, 'the previous registration is disposed, not leaked')

  onChange({ target: { checked: true } })
  assert.equal(storage.map.get(PREF_KEY), '1', 'preference persisted as 1')
  assert.deepEqual(env.panelIds(), ['skillhub'], 'sidebar row restored')
  assert.equal(env.ledger.registered, 2, 'exactly one re-registration')

  onChange({ target: { checked: true } })
  assert.equal(env.ledger.registered, 2, 'setting the same value twice does not churn registrations')
})

test('a stored preference is honoured on the next page load', () => {
  const first = boot(mapStorage(new Map([[PREF_KEY, '0']])))
  assert.deepEqual(first.env.panelIds(), [], 'stored "0" keeps the sidebar row hidden')

  const shown = boot(mapStorage(new Map([[PREF_KEY, '1']])))
  assert.deepEqual(shown.env.panelIds(), ['skillhub'], 'stored "1" restores the sidebar row')
})

test('the plugin unload disposer removes the sidebar contribution', () => {
  const { env } = boot(mapStorage())
  assert.deepEqual(env.panelIds(), ['skillhub'])
  env.disposeSidebar()
  assert.deepEqual(env.panelIds(), [], 'disposing the injection removes the entry')
})

test('unavailable storage falls back to visible without throwing', () => {
  const hostile = {
    getItem() { throw new Error('blocked') },
    setItem() { throw new Error('blocked') },
    removeItem() { throw new Error('blocked') },
  }
  const { env, plugin, captured } = boot(hostile)
  assert.deepEqual(env.panelIds(), ['skillhub'], 'a blocked localStorage must not hide the entry')
  env.settingsEntry().component({ t: (key) => key })
  assert.equal(captured.checkbox.checked, true)
  assert.doesNotThrow(() => captured.checkbox.onChange({ target: { checked: false } }), 'a blocked write must not throw')
  plugin.apply(createContext().ctx)
})
