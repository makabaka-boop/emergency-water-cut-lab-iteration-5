import {
  INVALID_NETWORK,
  NodeItem,
  ArcItem,
  BoundaryItem,
  ParseResult,
} from './types'

export const MAX_NODES = 10_000
export const MAX_ARCS = 50_000
export const MAX_CAPACITY = 1_000_000_000_000 // 10^12
export const MAX_TOTAL_CAPACITY = 9_000_000_000_000_000 // 9×10^15，小于 2^53，保证精确整数运算

const TOP_LEVEL_KEYS = ['nodes', 'arcs', 'sources', 'sinks'] as const

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isValidCapacity(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= MAX_CAPACITY
  )
}

/**
 * 解析并校验网络 JSON 文本。
 * 任何一条契约不满足都返回 INVALID_NETWORK（details 给出人类可读原因），
 * 调用方据此保留上次模型。
 */
export function parseNetwork(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return invalid(['JSON 解析失败：不是合法的 JSON 文本'])
  }
  return validateNetwork(raw)
}

export function validateNetwork(raw: unknown): ParseResult {
  const details: string[] = []

  if (!isPlainObject(raw)) {
    return invalid(['顶层必须是 JSON 对象'])
  }

  // 顶层仅允许 nodes / arcs / sources / sinks 四个数组，缺一不可、多一不可。
  for (const key of Object.keys(raw)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      details.push(`顶层存在未定义的字段 "${key}"`)
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in raw)) {
      details.push(`顶层缺少字段 "${key}"`)
    } else if (!Array.isArray(raw[key])) {
      details.push(`"${key}" 必须是数组`)
    }
  }
  if (details.length > 0) return invalid(details)

  const nodesRaw = raw.nodes as unknown[]
  const arcsRaw = raw.arcs as unknown[]
  const sourcesRaw = raw.sources as unknown[]
  const sinksRaw = raw.sinks as unknown[]

  if (nodesRaw.length > MAX_NODES) {
    details.push(`节点数 ${nodesRaw.length} 超过上限 ${MAX_NODES}`)
  }
  if (arcsRaw.length > MAX_ARCS) {
    details.push(`管段数 ${arcsRaw.length} 超过上限 ${MAX_ARCS}`)
  }
  if (details.length > 0) return invalid(details)

  // 节点：{ id } ，id 为非空字符串且互不重复。
  const nodes: NodeItem[] = []
  const nodeIds = new Set<string>()
  nodesRaw.forEach((item, i) => {
    if (!isPlainObject(item) || !isNonEmptyString(item.id)) {
      details.push(`nodes[${i}] 必须含非空字符串 id`)
      return
    }
    if (nodeIds.has(item.id)) {
      details.push(`节点 id "${item.id}" 重复`)
      return
    }
    nodeIds.add(item.id)
    nodes.push({ id: item.id })
  })

  // 管段：{ id, from, to, capacity }，id 在管段内唯一，from/to 必须指向已声明节点。
  const arcs: ArcItem[] = []
  const arcIds = new Set<string>()
  arcsRaw.forEach((item, i) => {
    if (!isPlainObject(item)) {
      details.push(`arcs[${i}] 必须是对象`)
      return
    }
    if (!isNonEmptyString(item.id)) {
      details.push(`arcs[${i}].id 必须是非空字符串`)
    } else if (arcIds.has(item.id)) {
      details.push(`管段 id "${item.id}" 重复`)
    }
    if (!isNonEmptyString(item.from) || !nodeIds.has(item.from)) {
      details.push(`arcs[${i}].from 必须指向已声明的节点 id`)
    }
    if (!isNonEmptyString(item.to) || !nodeIds.has(item.to)) {
      details.push(`arcs[${i}].to 必须指向已声明的节点 id`)
    }
    if (!isValidCapacity(item.capacity)) {
      details.push(`arcs[${i}].capacity 必须是 0..10^12 的整数`)
    }
    if (
      isNonEmptyString(item.id) &&
      !arcIds.has(item.id) &&
      isNonEmptyString(item.from) &&
      nodeIds.has(item.from) &&
      isNonEmptyString(item.to) &&
      nodeIds.has(item.to) &&
      isValidCapacity(item.capacity)
    ) {
      arcIds.add(item.id)
      arcs.push({
        id: item.id,
        from: item.from,
        to: item.to,
        capacity: item.capacity,
      })
    }
  })

  // 供水点 / 需求点：{ node, capacity }，node 指向已声明节点且各自不重复。
  const parseBoundary = (
    listRaw: unknown[],
    label: 'sources' | 'sinks',
  ): BoundaryItem[] => {
    const out: BoundaryItem[] = []
    const seen = new Set<string>()
    listRaw.forEach((item, i) => {
      if (!isPlainObject(item)) {
        details.push(`${label}[${i}] 必须是对象`)
        return
      }
      if (!isNonEmptyString(item.node) || !nodeIds.has(item.node)) {
        details.push(`${label}[${i}].node 必须指向已声明的节点 id`)
      } else if (seen.has(item.node)) {
        details.push(`${label}[${i}].node "${item.node}" 重复`)
      }
      if (!isValidCapacity(item.capacity)) {
        details.push(`${label}[${i}].capacity 必须是 0..10^12 的整数`)
      }
      if (
        isNonEmptyString(item.node) &&
        nodeIds.has(item.node) &&
        !seen.has(item.node) &&
        isValidCapacity(item.capacity)
      ) {
        seen.add(item.node)
        out.push({ node: item.node, capacity: item.capacity })
      }
    })
    return out
  }
  const sources = parseBoundary(sourcesRaw, 'sources')
  const sinks = parseBoundary(sinksRaw, 'sinks')

  if (details.length > 0) return invalid(details)

  // 容量总和不超过 9×10^15。所有容量非负，累计一旦越界即可判定，
  // 且 9×10^15 < 2^53，累加过程始终保持精确整数。
  let total = 0
  const accumulate = (c: number): boolean => {
    total += c
    return total <= MAX_TOTAL_CAPACITY
  }
  for (const a of arcs) {
    if (!accumulate(a.capacity)) {
      return invalid(['容量总和（管段+供水+需求）超过 9×10^15'])
    }
  }
  for (const s of sources) {
    if (!accumulate(s.capacity)) {
      return invalid(['容量总和（管段+供水+需求）超过 9×10^15'])
    }
  }
  for (const k of sinks) {
    if (!accumulate(k.capacity)) {
      return invalid(['容量总和（管段+供水+需求）超过 9×10^15'])
    }
  }

  return { ok: true, network: { nodes, arcs, sources, sinks } }
}

function invalid(details: string[]): ParseResult {
  return { ok: false, error: { code: INVALID_NETWORK, details } }
}
