import { describe, expect, it } from 'vitest'
import { parseNetwork, validateNetwork } from '../src/core/validate'

const MINIMAL = {
  nodes: [{ id: 's' }, { id: 't' }],
  arcs: [{ id: 'e', from: 's', to: 't', capacity: 5 }],
  sources: [{ node: 's', capacity: 5 }],
  sinks: [{ node: 't', capacity: 5 }],
}

function expectInvalid(raw: unknown) {
  const res = validateNetwork(raw)
  expect(res.ok).toBe(false)
  if (!res.ok) {
    expect(res.error.code).toBe('INVALID_NETWORK')
    expect(res.error.details.length).toBeGreaterThan(0)
  }
}

describe('合法网络', () => {
  it('最小网络', () => {
    const res = validateNetwork(MINIMAL)
    expect(res.ok).toBe(true)
  })

  it('空网络（四个空数组）', () => {
    expect(
      validateNetwork({ nodes: [], arcs: [], sources: [], sinks: [] }).ok,
    ).toBe(true)
  })

  it('重边、反向边、自环合法', () => {
    const res = validateNetwork({
      nodes: [{ id: 'a' }, { id: 'b' }],
      arcs: [
        { id: 'e1', from: 'a', to: 'b', capacity: 1 },
        { id: 'e2', from: 'a', to: 'b', capacity: 2 },
        { id: 'e3', from: 'b', to: 'a', capacity: 3 },
        { id: 'e4', from: 'a', to: 'a', capacity: 4 },
      ],
      sources: [],
      sinks: [],
    })
    expect(res.ok).toBe(true)
  })

  it('容量边界 0 与 10^12 均合法', () => {
    const res = validateNetwork({
      nodes: [{ id: 'a' }, { id: 'b' }],
      arcs: [
        { id: 'e1', from: 'a', to: 'b', capacity: 0 },
        { id: 'e2', from: 'a', to: 'b', capacity: 1_000_000_000_000 },
      ],
      sources: [{ node: 'a', capacity: 0 }],
      sinks: [{ node: 'b', capacity: 1_000_000_000_000 }],
    })
    expect(res.ok).toBe(true)
  })

  it('节点可同时是供水点与需求点', () => {
    const res = validateNetwork({
      nodes: [{ id: 'a' }],
      arcs: [],
      sources: [{ node: 'a', capacity: 1 }],
      sinks: [{ node: 'a', capacity: 1 }],
    })
    expect(res.ok).toBe(true)
  })

  it('节点数 10000、管段数 50000 恰在上限合法', () => {
    const nodes = Array.from({ length: 10_000 }, (_, i) => ({ id: `n${i}` }))
    const arcs = Array.from({ length: 50_000 }, (_, i) => ({
      id: `a${i}`,
      from: `n${i % 10_000}`,
      to: `n${(i + 1) % 10_000}`,
      capacity: 0,
    }))
    expect(validateNetwork({ nodes, arcs, sources: [], sinks: [] }).ok).toBe(
      true,
    )
  })

  it('容量总和恰为 9×10^15 合法', () => {
    // 9000 × 10^12 = 9×10^15，恰在上界
    const res = validateNetwork({
      nodes: [{ id: 'a' }, { id: 'b' }],
      arcs: Array.from({ length: 9000 }, (_, i) => ({
        id: `a${i}`,
        from: 'a',
        to: 'b',
        capacity: 1_000_000_000_000,
      })),
      sources: [],
      sinks: [],
    })
    expect(res.ok).toBe(true)
  })
})

describe('非法网络 → INVALID_NETWORK', () => {
  it('JSON 解析失败', () => {
    const res = parseNetwork('{not json')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error.code).toBe('INVALID_NETWORK')
  })

  it('顶层不是对象', () => {
    expectInvalid([1, 2, 3])
    expectInvalid(null)
    expectInvalid('hello')
    expectInvalid(42)
  })

  it('缺少必需字段 / 字段不是数组 / 多出未知字段', () => {
    const { sinks: _omit, ...missing } = MINIMAL
    expectInvalid(missing)
    expectInvalid({ ...MINIMAL, nodes: {} })
    expectInvalid({ ...MINIMAL, extra: [] })
  })

  it('节点 id 非空字符串且唯一', () => {
    expectInvalid({ ...MINIMAL, nodes: [{ id: '' }] })
    expectInvalid({ ...MINIMAL, nodes: [{ id: 1 }] })
    expectInvalid({ ...MINIMAL, nodes: [{}] })
    expectInvalid({ ...MINIMAL, nodes: ['s'] })
    expectInvalid({ ...MINIMAL, nodes: [{ id: 's' }, { id: 's' }] })
  })

  it('管段 id 非空字符串且在管段内唯一', () => {
    expectInvalid({
      ...MINIMAL,
      arcs: [{ id: '', from: 's', to: 't', capacity: 1 }],
    })
    expectInvalid({
      ...MINIMAL,
      arcs: [
        { id: 'e', from: 's', to: 't', capacity: 1 },
        { id: 'e', from: 't', to: 's', capacity: 1 },
      ],
    })
  })

  it('管段 from/to 必须指向已声明节点', () => {
    expectInvalid({
      ...MINIMAL,
      arcs: [{ id: 'e', from: 's', to: 'ghost', capacity: 1 }],
    })
    expectInvalid({
      ...MINIMAL,
      arcs: [{ id: 'e', from: 1, to: 't', capacity: 1 }],
    })
  })

  it('容量必须是 0..10^12 的整数', () => {
    const bad = [-1, 1.5, 1_000_000_000_001, '5', null, true, {}]
    for (const capacity of bad) {
      expectInvalid({
        ...MINIMAL,
        arcs: [{ id: 'e', from: 's', to: 't', capacity }],
      })
      expectInvalid({ ...MINIMAL, sources: [{ node: 's', capacity }] })
      expectInvalid({ ...MINIMAL, sinks: [{ node: 't', capacity }] })
    }
  })

  it('供水点/需求点 node 必须已声明且各自不重复', () => {
    expectInvalid({ ...MINIMAL, sources: [{ node: 'ghost', capacity: 1 }] })
    expectInvalid({ ...MINIMAL, sinks: [{ node: 'ghost', capacity: 1 }] })
    expectInvalid({
      ...MINIMAL,
      sources: [
        { node: 's', capacity: 1 },
        { node: 's', capacity: 2 },
      ],
    })
    expectInvalid({
      ...MINIMAL,
      sinks: [
        { node: 't', capacity: 1 },
        { node: 't', capacity: 2 },
      ],
    })
  })

  it('节点数 / 管段数超上限', () => {
    const nodes10001 = Array.from({ length: 10_001 }, (_, i) => ({
      id: `n${i}`,
    }))
    expectInvalid({ nodes: nodes10001, arcs: [], sources: [], sinks: [] })
    const arcs50001 = Array.from({ length: 50_001 }, (_, i) => ({
      id: `a${i}`,
      from: 's',
      to: 't',
      capacity: 0,
    }))
    expectInvalid({ ...MINIMAL, arcs: arcs50001 })
  })

  it('容量总和超过 9×10^15', () => {
    // 9001 × 10^12 = 9.001×10^15 > 9×10^15
    expectInvalid({
      nodes: [{ id: 'a' }, { id: 'b' }],
      arcs: Array.from({ length: 9001 }, (_, i) => ({
        id: `a${i}`,
        from: 'a',
        to: 'b',
        capacity: 1_000_000_000_000,
      })),
      sources: [],
      sinks: [],
    })
    // 管段、供水、需求三方合计超限同样非法：9000×10^12 + 10^12 + 10^12
    expectInvalid({
      nodes: [{ id: 'a' }, { id: 'b' }],
      arcs: Array.from({ length: 9000 }, (_, i) => ({
        id: `a${i}`,
        from: 'a',
        to: 'b',
        capacity: 1_000_000_000_000,
      })),
      sources: [{ node: 'a', capacity: 1_000_000_000_000 }],
      sinks: [{ node: 'b', capacity: 1_000_000_000_000 }],
    })
  })
})
