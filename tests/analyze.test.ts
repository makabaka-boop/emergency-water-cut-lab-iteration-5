import { describe, expect, it } from 'vitest'
import { analyze, relativeLoss } from '../src/core/analyze'
import { formatInt, formatPercent } from '../src/core/format'
import { Network } from '../src/core/types'

const NET: Network = {
  nodes: [{ id: 's' }, { id: 'a' }, { id: 'b' }, { id: 't' }],
  arcs: [
    { id: 'e1', from: 's', to: 'a', capacity: 10 },
    { id: 'e2', from: 's', to: 'b', capacity: 8 },
    { id: 'e3', from: 'a', to: 't', capacity: 10 },
    { id: 'e4', from: 'b', to: 't', capacity: 8 },
    { id: 'e5', from: 'a', to: 'b', capacity: 1 },
  ],
  sources: [{ node: 's', capacity: 100 }],
  sinks: [{ node: 't', capacity: 100 }],
}

describe('断管演练', () => {
  it('基线：最大供水量与割项', () => {
    const res = analyze(NET, new Set())
    expect(res.value).toBe(18)
    expect(res.cut).toEqual([
      { kind: 'arc', id: 'e1', from: 's', to: 'a', capacity: 10 },
      { kind: 'arc', id: 'e2', from: 's', to: 'b', capacity: 8 },
    ])
    expect(res.disabled).toEqual([])
  })

  it('逐项停用：当前值、相对损失与新割项', () => {
    // 停用瓶颈管段 e1 → 只剩 e2 通路
    const step1 = analyze(NET, new Set(['e1']))
    expect(step1.value).toBe(8)
    expect(step1.disabled).toEqual(['e1'])
    expect(step1.cut).toEqual([
      { kind: 'arc', id: 'e2', from: 's', to: 'b', capacity: 8 },
    ])
    expect(relativeLoss(18, step1.value)).toBeCloseTo(10 / 18, 12)

    // 再停用 e2 → 完全断供，割项为空
    const step2 = analyze(NET, new Set(['e1', 'e2']))
    expect(step2.value).toBe(0)
    expect(step2.cut).toEqual([])
    expect(relativeLoss(18, step2.value)).toBe(1)
  })

  it('停用非瓶颈管段：供水量与割项不变', () => {
    const res = analyze(NET, new Set(['e5']))
    expect(res.value).toBe(18)
    expect(res.cut.map((c) => c.id)).toEqual(['e1', 'e2'])
    expect(relativeLoss(18, res.value)).toBe(0)
  })

  it('清空方案精确回到基线', () => {
    const baseline = analyze(NET, new Set())
    // 模拟工程师逐项停用又逐一恢复
    analyze(NET, new Set(['e1']))
    analyze(NET, new Set(['e1', 'e2']))
    analyze(NET, new Set(['e2']))
    const restored = analyze(NET, new Set())
    expect(restored).toEqual(baseline)
  })

  it('相对损失：基线为 0 时约定为 0', () => {
    expect(relativeLoss(0, 0)).toBe(0)
    expect(relativeLoss(18, 18)).toBe(0)
    expect(relativeLoss(18, 0)).toBe(1)
  })
})

describe('割项排序：类别 → id UTF-16 升序', () => {
  it('多类别多字符集混合排序', () => {
    const net: Network = {
      nodes: [
        'src-a',
        '水厂',
        'src-b',
        'm1',
        'm2',
        'm3',
        't0',
        't1',
        't2',
        't3',
        't4',
        '😀避难',
      ].map((id) => ({ id })),
      arcs: [
        { id: 'x', from: 'src-a', to: 't0', capacity: 100 },
        { id: 'w', from: '水厂', to: 't0', capacity: 100 },
        { id: 'arc-2', from: 'src-b', to: 'm1', capacity: 5 },
        { id: 'arc-10', from: 'src-b', to: 'm2', capacity: 8 },
        { id: 'arc-A', from: 'src-b', to: 'm3', capacity: 6 },
        { id: 'y1', from: 'm1', to: 't1', capacity: 100 },
        { id: 'y2', from: 'm2', to: 't2', capacity: 100 },
        { id: 'y3', from: 'm3', to: 't3', capacity: 100 },
        { id: 'arc-b', from: 'src-b', to: 't4', capacity: 100 },
        { id: 'z', from: 'src-b', to: '😀避难', capacity: 100 },
      ],
      sources: [
        { node: 'src-a', capacity: 3 },
        { node: '水厂', capacity: 2 },
        { node: 'src-b', capacity: 100 },
      ],
      sinks: [
        { node: 't0', capacity: 100 },
        { node: 't1', capacity: 100 },
        { node: 't2', capacity: 100 },
        { node: 't3', capacity: 100 },
        { node: 't4', capacity: 7 },
        { node: '😀避难', capacity: 1 },
      ],
    }
    const res = analyze(net, new Set())
    expect(res.value).toBe(32)
    expect(res.cut).toEqual([
      { kind: 'source', id: 'src-a', capacity: 3 },
      { kind: 'source', id: '水厂', capacity: 2 },
      { kind: 'arc', id: 'arc-10', from: 'src-b', to: 'm2', capacity: 8 },
      { kind: 'arc', id: 'arc-2', from: 'src-b', to: 'm1', capacity: 5 },
      { kind: 'arc', id: 'arc-A', from: 'src-b', to: 'm3', capacity: 6 },
      { kind: 'sink', id: 't4', capacity: 7 },
      { kind: 'sink', id: '😀避难', capacity: 1 },
    ])
  })
})

describe('展示格式化', () => {
  it('整数千分位', () => {
    expect(formatInt(0)).toBe('0')
    expect(formatInt(18)).toBe('18')
    expect(formatInt(3_000_000_000_000_000)).toBe('3,000,000,000,000,000')
  })

  it('百分比', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(1)).toBe('100%')
    expect(formatPercent(0.25)).toBe('25%')
    expect(formatPercent(1 / 3)).toBe('33.3333%')
    expect(formatPercent(10 / 18)).toBe('55.5556%')
  })
})
