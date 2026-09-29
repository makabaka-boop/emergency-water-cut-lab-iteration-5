/** 整数按千分位分组显示（输入必为安全整数，toString 精确）。 */
export function formatInt(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 相对损失百分比，保留 4 位小数并去掉多余的 0。 */
export function formatPercent(ratio: number): string {
  const pct = (ratio * 100).toFixed(4)
  return `${pct.replace(/\.?0+$/, '')}%`
}
