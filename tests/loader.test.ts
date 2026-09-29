import { describe, expect, it } from 'vitest'
import {
  beginFileRead,
  initialLoaderState,
  reduceEditDraft,
  reduceLoad,
  settleFileRead,
} from '../src/core/loader'
import { SAMPLE_TEXT } from '../src/core/sample'

const TINY = JSON.stringify({
  nodes: [{ id: 's' }, { id: 't' }],
  arcs: [{ id: 'e', from: 's', to: 't', capacity: 5 }],
  sources: [{ node: 's', capacity: 5 }],
  sinks: [{ node: 't', capacity: 5 }],
})

/** 与 TINY 不同的另一张合法网（基线值 9），用于区分模型是否被替换。 */
const TINY_B = JSON.stringify({
  nodes: [{ id: 's' }, { id: 't' }],
  arcs: [{ id: 'e', from: 's', to: 't', capacity: 9 }],
  sources: [{ node: 's', capacity: 9 }],
  sinks: [{ node: 't', capacity: 9 }],
})

describe('载入状态机', () => {
  it('合法文本：替换模型并核算基线', () => {
    const state = reduceLoad(initialLoaderState, TINY)
    expect(state.error).toBeNull()
    expect(state.model).not.toBeNull()
    expect(state.model!.baseline.value).toBe(5)
    expect(state.model!.baseline.disabled).toEqual([])
    // 文本载入：草稿与模型同源
    expect(state.draft).toBe(TINY)
    expect(state.modelText).toBe(TINY)
    expect(state.modelSource).toEqual({ kind: 'text' })
    expect(state.pendingFile).toBeNull()
  })

  it('非法文本：INVALID_NETWORK 且保留上次模型（引用不变）', () => {
    const loaded = reduceLoad(initialLoaderState, TINY)
    const model = loaded.model
    const failed = reduceLoad(loaded, '{broken')
    expect(failed.error?.code).toBe('INVALID_NETWORK')
    expect(failed.model).toBe(model)

    // 契约层面的非法同样保留模型
    const failed2 = reduceLoad(loaded, '{"nodes":[],"arcs":[],"sources":[]}')
    expect(failed2.error?.code).toBe('INVALID_NETWORK')
    expect(failed2.model).toBe(model)
    // 被拒绝的内容同步进草稿，错误详情对应文本框中可见的输入
    expect(failed2.draft).toBe('{"nodes":[],"arcs":[],"sources":[]}')
    expect(failed2.modelText).toBe(TINY)
    expect(failed2.errorSource).toEqual({ kind: 'text' })
  })

  it('再次载入合法文本：替换模型并清除错误', () => {
    let state = reduceLoad(initialLoaderState, TINY)
    state = reduceLoad(state, '{broken')
    expect(state.error).not.toBeNull()
    state = reduceLoad(state, SAMPLE_TEXT)
    expect(state.error).toBeNull()
    expect(state.model!.baseline.value).toBeGreaterThan(0)
  })

  it('内置示例本身合法且可复算', () => {
    const state = reduceLoad(initialLoaderState, SAMPLE_TEXT)
    expect(state.error).toBeNull()
    const baseline = state.model!.baseline
    // 示例：供给 115 = 需求 115，管网可全部送达
    expect(baseline.value).toBe(115)
    const cutSum = baseline.cut.reduce((s, c) => s + c.capacity, 0)
    expect(cutSum).toBe(baseline.value)
  })
})

describe('载入来源一致性', () => {
  it('文件读取成功：替换模型、文件内容同步进文本草稿并记录文件来源', () => {
    let s = beginFileRead(initialLoaderState, '正式管网.json', 1)
    expect(s.pendingFile).toEqual({ token: 1, name: '正式管网.json' })
    s = settleFileRead(s, 1, { ok: true, text: TINY })
    expect(s.error).toBeNull()
    expect(s.model!.baseline.value).toBe(5)
    // 文件内容同步到文本框：草稿即当前模型的来源，重新解析不会回退到旧草稿
    expect(s.draft).toBe(TINY)
    expect(s.modelText).toBe(TINY)
    expect(s.modelSource).toEqual({ kind: 'file', name: '正式管网.json' })
    expect(s.errorSource).toBeNull()
    expect(s.pendingFile).toBeNull()
  })

  it('文件读取失败：转为 INVALID_NETWORK，模型与草稿原样保留，错误点名文件与原因', () => {
    const loaded = reduceLoad(initialLoaderState, TINY)
    let s = beginFileRead(loaded, '损坏.json', 1)
    s = settleFileRead(s, 1, { ok: false, reason: '读取权限不足' })
    expect(s.error?.code).toBe('INVALID_NETWORK')
    expect(s.error!.details.join('\n')).toContain('损坏.json')
    expect(s.error!.details.join('\n')).toContain('读取权限不足')
    // 模型引用不变 → 停用集合、需求点选择与联合承诺（以模型引用为锚）全部保留
    expect(s.model).toBe(loaded.model)
    expect(s.modelText).toBe(loaded.modelText)
    expect(s.modelSource).toBe(loaded.modelSource)
    expect(s.draft).toBe(loaded.draft)
    expect(s.errorSource).toEqual({ kind: 'file', name: '损坏.json' })
    expect(s.pendingFile).toBeNull()
  })

  it('文件内容非法：保留上次模型，被拒绝的内容进入文本框，错误对应可见输入', () => {
    const loaded = reduceLoad(initialLoaderState, TINY)
    let s = beginFileRead(loaded, 'bad.json', 1)
    s = settleFileRead(s, 1, { ok: true, text: '{broken' })
    expect(s.error?.code).toBe('INVALID_NETWORK')
    expect(s.model).toBe(loaded.model)
    // 错误详情对应的内容显示在文本框中，用户可对照定位并修正
    expect(s.draft).toBe('{broken')
    expect(s.modelText).toBe(TINY)
    expect(s.errorSource).toEqual({ kind: 'file', name: 'bad.json' })
    expect(s.pendingFile).toBeNull()
  })

  it('载入内置示例：草稿同步为示例文本并记录示例来源', () => {
    const s = reduceLoad(initialLoaderState, SAMPLE_TEXT, { kind: 'sample' })
    expect(s.error).toBeNull()
    expect(s.draft).toBe(SAMPLE_TEXT)
    expect(s.modelText).toBe(SAMPLE_TEXT)
    expect(s.modelSource).toEqual({ kind: 'sample' })
  })

  it('解析失败后再次载入合法文本：替换模型并清除错误与错误来源', () => {
    let s = reduceLoad(initialLoaderState, TINY)
    s = reduceLoad(s, '{broken')
    expect(s.error).not.toBeNull()
    expect(s.errorSource).toEqual({ kind: 'text' })
    s = reduceLoad(s, TINY_B)
    expect(s.error).toBeNull()
    expect(s.errorSource).toBeNull()
    expect(s.model!.baseline.value).toBe(9)
    expect(s.draft).toBe(TINY_B)
    expect(s.modelText).toBe(TINY_B)
  })

  it('编辑草稿只更新草稿：模型、错误与来源不受影响', () => {
    let s = reduceLoad(initialLoaderState, TINY)
    const model = s.model
    s = reduceEditDraft(s, TINY_B)
    expect(s.draft).toBe(TINY_B)
    expect(s.model).toBe(model)
    expect(s.modelText).toBe(TINY)
    expect(s.error).toBeNull()
  })
})

describe('载入交错控制：只有最后一次用户操作决定结果', () => {
  it('读取期间载入示例：迟到的文件结果被整体丢弃', () => {
    let s = beginFileRead(initialLoaderState, 'a.json', 1)
    s = reduceLoad(s, SAMPLE_TEXT, { kind: 'sample' })
    expect(s.pendingFile).toBeNull()
    const settled = settleFileRead(s, 1, { ok: true, text: TINY })
    expect(settled).toBe(s) // 状态原样返回（引用不变）
    expect(settled.model!.baseline.value).toBe(115)
    expect(settled.draft).toBe(SAMPLE_TEXT)
    expect(settled.modelSource).toEqual({ kind: 'sample' })
  })

  it('读取期间解析文本：迟到的文件结果被整体丢弃', () => {
    let s = beginFileRead(initialLoaderState, 'a.json', 1)
    s = reduceLoad(s, TINY)
    const settled = settleFileRead(s, 1, { ok: true, text: TINY_B })
    expect(settled).toBe(s)
    expect(settled.model!.baseline.value).toBe(5)
    expect(settled.modelSource).toEqual({ kind: 'text' })
  })

  it('读取期间编辑草稿：迟到的文件结果不得覆盖用户正在编辑的内容', () => {
    let s = beginFileRead(initialLoaderState, 'a.json', 1)
    s = reduceEditDraft(s, '{ "nodes": ')
    expect(s.pendingFile).toBeNull()
    const settled = settleFileRead(s, 1, { ok: true, text: TINY })
    expect(settled).toBe(s)
    expect(settled.draft).toBe('{ "nodes": ')
    expect(settled.model).toBeNull()
  })

  it('连续选择两个文件：先完成的旧读取被丢弃，后读取的生效', () => {
    let s = beginFileRead(initialLoaderState, 'a.json', 1)
    s = beginFileRead(s, 'b.json', 2)
    const stale = settleFileRead(s, 1, { ok: true, text: TINY })
    expect(stale).toBe(s) // a.json 迟到 → 整体丢弃，b.json 仍在途
    expect(stale.pendingFile).toEqual({ token: 2, name: 'b.json' })
    expect(stale.model).toBeNull()
    s = settleFileRead(stale, 2, { ok: true, text: TINY_B })
    expect(s.model!.baseline.value).toBe(9)
    expect(s.modelSource).toEqual({ kind: 'file', name: 'b.json' })
    expect(s.pendingFile).toBeNull()
  })

  it('迟到的读取失败同样被丢弃：不产生错误、不影响新模型', () => {
    let s = beginFileRead(initialLoaderState, 'a.json', 1)
    s = reduceLoad(s, SAMPLE_TEXT, { kind: 'sample' })
    const settled = settleFileRead(s, 1, { ok: false, reason: 'I/O error' })
    expect(settled).toBe(s)
    expect(settled.error).toBeNull()
    expect(settled.model!.baseline.value).toBe(115)
  })

  it('同一 token 重复回填：第二次为无操作', () => {
    let s = beginFileRead(initialLoaderState, 'a.json', 1)
    s = settleFileRead(s, 1, { ok: true, text: TINY })
    const again = settleFileRead(s, 1, { ok: true, text: TINY_B })
    expect(again).toBe(s)
    expect(again.model!.baseline.value).toBe(5)
  })

  it('综合交错：文件、示例、文本解析与失败依次覆盖，全部状态以最后一次操作为准', () => {
    // 1. 选择正式文件（在途）
    let s = beginFileRead(initialLoaderState, '正式管网.json', 1)
    // 2. 读取期间载入示例 → 文件读取作废
    s = reduceLoad(s, SAMPLE_TEXT, { kind: 'sample' })
    // 3. 正式文件迟到完成 → 整体丢弃，示例模型保留
    s = settleFileRead(s, 1, { ok: true, text: TINY })
    expect(s.model!.baseline.value).toBe(115)
    expect(s.draft).toBe(SAMPLE_TEXT)
    expect(s.modelSource).toEqual({ kind: 'sample' })
    expect(s.error).toBeNull()
    // 4. 选择损坏文件并读取失败 → INVALID_NETWORK，示例模型与草稿保留
    s = beginFileRead(s, '损坏.json', 2)
    s = settleFileRead(s, 2, { ok: false, reason: 'I/O error' })
    expect(s.error?.code).toBe('INVALID_NETWORK')
    expect(s.model!.baseline.value).toBe(115)
    expect(s.draft).toBe(SAMPLE_TEXT)
    expect(s.errorSource).toEqual({ kind: 'file', name: '损坏.json' })
    // 5. 在文本框修正内容后解析 → 新模型，错误清除，来源回到文本框
    s = reduceEditDraft(s, TINY_B)
    s = reduceLoad(s, s.draft)
    expect(s.error).toBeNull()
    expect(s.errorSource).toBeNull()
    expect(s.model!.baseline.value).toBe(9)
    expect(s.draft).toBe(TINY_B)
    expect(s.modelText).toBe(TINY_B)
    expect(s.modelSource).toEqual({ kind: 'text' })
    // 6. 再选文件并成功 → 文件内容同步进草稿，来源指向文件
    s = beginFileRead(s, '正式管网.json', 3)
    s = settleFileRead(s, 3, { ok: true, text: TINY })
    expect(s.model!.baseline.value).toBe(5)
    expect(s.draft).toBe(TINY)
    expect(s.modelSource).toEqual({ kind: 'file', name: '正式管网.json' })
  })
})
