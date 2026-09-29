import { describe, expect, it } from 'vitest'
import { analyze, compareCutItems, compareUtf16 } from '../src/core/analyze'
import {
  bruteForceMinCut,
  independentSolve,
  mulberry32,
  randomDisabled,
  randomNetwork,
} from './helpers'

describe('穷举割集交叉验证', () => {
  it('300 个随机小图：最大供水量 = 穷举最小割，割项与独立重建逐项一致', () => {
    const rng = mulberry32(20260918)
    for (let round = 0; round < 300; round++) {
      const net = randomNetwork(rng)
      const disabled = randomDisabled(net, rng)

      const analysis = analyze(net, disabled)
      const indep = independentSolve(net, disabled)
      const brute = bruteForceMinCut(net, disabled)

      // 最大流值 = 穷举全部二分得到的最小割容量。
      expect(analysis.value).toBe(brute)
      expect(indep.value).toBe(brute)
      expect(Number.isSafeInteger(analysis.value)).toBe(true)

      // 割项与「由流量独立重建残量网络」的结果逐项一致。
      expect(analysis.cut).toEqual(indep.cut)

      // 割项容量之和恰为最大供水量。
      const cutSum = analysis.cut.reduce((s, c) => s + c.capacity, 0)
      expect(cutSum).toBe(analysis.value)

      // 割项严格按 类别 → id(UTF-16) 升序。
      for (let i = 1; i < analysis.cut.length; i++) {
        expect(
          compareCutItems(analysis.cut[i - 1], analysis.cut[i]),
        ).toBeLessThan(0)
      }

      // 方案中的停用清单为 UTF-16 升序。
      expect(analysis.disabled).toEqual([...disabled].sort(compareUtf16))
    }
  })

  it('空方案重算结果逐项相等（确定性）', () => {
    const rng = mulberry32(7)
    for (let round = 0; round < 30; round++) {
      const net = randomNetwork(rng)
      const a = analyze(net, new Set())
      const b = analyze(net, new Set())
      expect(a).toEqual(b)
    }
  })
})
