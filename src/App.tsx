import { ChangeEvent, memo, ReactNode, useMemo, useRef, useState } from 'react'
import { relativeLoss, solvePlan, PlanSolution } from './core/analyze'
import { jointCommitmentByNode } from './core/commitment'
import { formatInt, formatPercent } from './core/format'
import {
  GapDiagnosis,
  minimumCommitmentGapByNode,
} from './core/gap'
import { sinkIntervalByNode } from './core/interval'
import {
  LoadSource,
  beginFileRead,
  initialLoaderState,
  reduceEditDraft,
  reduceLoad,
  settleFileRead,
} from './core/loader'
import { SAMPLE_TEXT } from './core/sample'
import { Analysis, CutItem, CutKind, Model, SinkInterval } from './core/types'

const KIND_LABEL: Record<CutKind, string> = {
  source: '供水点',
  arc: '管段',
  sink: '需求点',
}

/** 载入来源的展示文案：文件带文件名，便于工程师确认当前模型 / 错误出自哪次输入。 */
function sourceLabel(source: LoadSource): string {
  switch (source.kind) {
    case 'file':
      return `文件「${source.name}」`
    case 'sample':
      return '内置示例'
    case 'text':
      return '文本框'
  }
}

const PAGE_SIZE = 100

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 复核报告：自包含（含网络与方案），可脱离页面独立重算验证。 */
function buildReport(
  kind: 'baseline' | 'drill',
  model: Model,
  analysis: Analysis,
) {
  return {
    report: kind,
    generatedAt: new Date().toISOString(),
    network: model.network,
    disabledArcIds: analysis.disabled,
    maxSupply: analysis.value,
    cut: analysis.cut,
    loss: model.baseline.value - analysis.value,
    relativeLoss: relativeLoss(model.baseline.value, analysis.value),
  }
}

function CutTable({
  cut,
  onDisableArc,
  toneOf,
}: {
  cut: CutItem[]
  onDisableArc?: (id: string) => void
  toneOf?: (kind: CutKind, id: string) => 'none' | 'flow' | 'saturated' | 'short'
}) {
  if (cut.length === 0) {
    return <p className="muted">割项为空（当前网络无源侧到汇侧的割边）。</p>
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>类别</th>
          <th>ID</th>
          <th>起点 → 终点</th>
          <th className="num">容量</th>
          {onDisableArc && <th>操作</th>}
        </tr>
      </thead>
      <tbody>
        {cut.map((item) => {
          const tone = toneOf ? toneOf(item.kind, item.id) : 'none'
          return (
            <tr
              key={`${item.kind}:${item.id}`}
              className={tone !== 'none' ? `tone-row tone-${tone}` : undefined}
            >
              <td>{KIND_LABEL[item.kind]}</td>
              <td className="mono">{item.id}</td>
              <td className="mono">
                {item.kind === 'arc' ? `${item.from} → ${item.to}` : '—'}
              </td>
              <td className="num mono">{formatInt(item.capacity)}</td>
              {onDisableArc && (
                <td>
                  {item.kind === 'arc' && (
                    <button
                      className="link-btn"
                      onClick={() => onDisableArc(item.id)}
                    >
                      停用
                    </button>
                  )}
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function ValueBlock({
  label,
  value,
  suffix,
}: {
  label: string
  value: string
  suffix?: string
}) {
  return (
    <div className="value-block">
      <div className="value-label">{label}</div>
      <div className="value-number mono">
        {value}
        {suffix && <span className="value-suffix">{suffix}</span>}
      </div>
    </div>
  )
}

/**
 * 避难点供水区间面板：工程师从当前模型的需求点中选择一个，
 * 显示保持当前最大供水总量不变时，该点可获水量的最小值、
 * 当前 Dinic 方案值、最大值。当前值仅为一组可行分配。
 *
 * 辅助求解失败（含所选需求点在当前模型中不存在）时就地提示，
 * 不影响已成功的核算/演练结果。
 */
function SinkIntervalPanel({
  sinks,
  selected,
  onSelect,
  interval,
  failed,
}: {
  sinks: Model['network']['sinks']
  selected: string
  onSelect: (id: string) => void
  interval: SinkInterval | null
  failed: string | null
}) {
  return (
    <div className="interval-box">
      <div className="interval-toolbar">
        <label>选择避难点（需求点）</label>
        <select
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
        >
          {sinks.map((k) => (
            <option key={k.node} value={k.node}>
              {k.node}（需求能力 {formatInt(k.capacity)}）
            </option>
          ))}
        </select>
      </div>
      {failed && (
        <p className="interval-error" role="alert">
          供水区间求解失败：{failed}。已清除旧区间，核算与演练结果不受影响。
        </p>
      )}
      {!failed && interval && (
        <>
          <div className="value-row">
            <ValueBlock label="最小可获水量" value={formatInt(interval.min)} />
            <ValueBlock label="当前 Dinic 方案" value={formatInt(interval.current)} />
            <ValueBlock label="最大可获水量" value={formatInt(interval.max)} />
          </div>
          <p className="muted interval-note">
            区间在最大供水总量保持 {formatInt(interval.total)} 不变的前提下成立，
            端点均不突破容量与节点守恒；当前 Dinic 方案值{' '}
            {formatInt(interval.current)} 只是总值 {formatInt(interval.total)}{' '}
            下的一组可行分配，并非唯一答案。
          </p>
        </>
      )}
    </div>
  )
}

/** 承诺输入解析：空串 = 留空；否则必须是 0..capacity 的整数（不含科学计数/小数/前导空格外的杂符）。 */
function parseCommitment(
  raw: string,
  capacity: number,
): { kind: 'empty' } | { kind: 'ok'; value: number } | { kind: 'error' } {
  const t = raw.trim()
  if (t === '') return { kind: 'empty' }
  if (!/^\d+$/.test(t)) return { kind: 'error' }
  const value = Number(t)
  if (!Number.isSafeInteger(value) || value < 0 || value > capacity) {
    return { kind: 'error' }
  }
  return { kind: 'ok', value }
}

type JointVerdict =
  | { kind: 'idle' }
  | { kind: 'invalid'; invalidNodes: string[] }
  | { kind: 'feasible'; total: number; committed: number }
  | { kind: 'infeasible'; total: number; committed: number }
  | { kind: 'failed'; reason: string }

/** 单行承诺输入：memo 化避免上万需求点时整表随键入重渲染。 */
const CommitmentRow = memo(function CommitmentRow({
  node,
  capacity,
  value,
  invalid,
  onChange,
  extra,
}: {
  node: string
  capacity: number
  value: string
  invalid: boolean
  onChange: (node: string, value: string) => void
  /** 诊断已提交时附加的「实际供水 / 缺口」单元格。 */
  extra?: ReactNode
}) {
  return (
    <tr className={invalid ? 'commit-invalid-row' : ''}>
      <td className="mono">{node}</td>
      <td className="num mono">{formatInt(capacity)}</td>
      <td>
        <input
          className="commit-input"
          inputMode="numeric"
          placeholder="留空"
          aria-label={`需求点 ${node} 的最低供水量承诺（留空或 0..${capacity} 的整数）`}
          aria-invalid={invalid}
          value={value}
          onChange={(e) => onChange(node, e.target.value)}
        />
        {invalid && (
          <span className="commit-field-error" role="alert">
            须为留空或 0..{formatInt(capacity)} 的整数
          </span>
        )}
      </td>
      {extra}
    </tr>
  )
})

/**
 * 联合最低供水承诺面板（仅当前断管演练）：
 * 工程师可同时为多个需求点填写最低供水量，每项可留空。页面随填写、停用/恢复
 * 管段、清空方案自动重新裁决。裁决针对同一组边流量，严格锁定当前总量，
 * 不拼接单点区间、不只比较承诺总和；可行时只显示结论与固定总量，不给逐边分配。
 */
const COMMIT_PAGE_SIZE = 100

function JointCommitmentPanel({
  sinks,
  values,
  verdict,
  onChange,
}: {
  sinks: Model['network']['sinks']
  values: Record<string, string>
  verdict: JointVerdict
  onChange: (node: string, value: string) => void
}) {
  // 需求点可能上万：分页渲染，配合行 memo 保证键入不卡顿。
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(sinks.length / COMMIT_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageSinks = sinks.slice(
    safePage * COMMIT_PAGE_SIZE,
    (safePage + 1) * COMMIT_PAGE_SIZE,
  )

  return (
    <div className="interval-box">
      <p className="muted interval-note">
        为多个需求点同时填写最低供水量（每项可留空，须为 0 至该点容量的整数），
        页面随填写与停用/恢复管段重新裁决：在容量与节点守恒成立、
        超级源到超级汇总量严格等于当前最大供水量的同一组边流量上，
        全部下限能否同时满足。
      </p>
      <table className="data-table commit-table">
        <thead>
          <tr>
            <th>需求点</th>
            <th className="num">需求容量</th>
            <th>最低供水承诺</th>
          </tr>
        </thead>
        <tbody>
          {pageSinks.map((k) => (
            <CommitmentRow
              key={k.node}
              node={k.node}
              capacity={k.capacity}
              value={values[k.node] ?? ''}
              invalid={
                verdict.kind === 'invalid' &&
                verdict.invalidNodes.includes(k.node)
              }
              onChange={onChange}
            />
          ))}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div className="arc-toolbar">
          <span className="muted">
            共 {formatInt(sinks.length)} 个需求点 · 第 {safePage + 1} / {pageCount} 页
          </span>
          <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            上一页
          </button>
          <button
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)}
          >
            下一页
          </button>
        </div>
      )}

      {verdict.kind === 'invalid' && (
        <p className="interval-error" role="alert">
          存在无效填写{verdict.invalidNodes.length > 1 ? `（${verdict.invalidNodes.length} 处）` : ''}
          ：需求点「{verdict.invalidNodes[0]}」
          {verdict.invalidNodes.length > 1 ? ' 等' : ''}
          的承诺须为留空或 0 至其容量的整数。已清除联合裁决，核算、演练与单点
          供水区间不受影响。
        </p>
      )}
      {verdict.kind === 'failed' && (
        <p className="interval-error" role="alert">
          联合裁决辅助求解失败（{verdict.reason}），已清除联合裁决；
          核算、演练与单点供水区间不受影响。
        </p>
      )}
      {verdict.kind === 'infeasible' && (
        <p className="commit-infeasible" role="alert">
          联合约束不满足：在固定总供水量 {formatInt(verdict.total)} 下，
          {verdict.committed} 项最低承诺无法在同一组边流量上同时兑现
          （承诺总和未超限也可能因共享管段等局部瓶颈被否决）。
        </p>
      )}
      {verdict.kind === 'feasible' && (
        <p className="commit-feasible" role="status">
          ✔ 可同时兑现：{verdict.committed} 项承诺在固定总供水量{' '}
          <strong className="mono">{formatInt(verdict.total)}</strong>{' '}
          下存在同一组可行边流量（不展示逐边分配）。
        </p>
      )}
      {verdict.kind === 'idle' && (
        <p className="muted interval-note">
          尚未填写任何承诺；填写后立即联合裁决。
        </p>
      )}
    </div>
  )
}

/**
 * 最小承诺缺口诊断面板（opt-in，需显式运行）。
 *
 * 与上方实时「联合裁决」相互独立：这里点击「运行诊断」才把当前承诺与当前网络
 * （含停用管段）提交一次，产出一份不可变的已提交结果——总缺口、逐点实际供水
 * 与缺口、完整流量见证。页面摘要与网络着色共用同一份已提交结果；承诺或停用
 * 状态在运行后被改动时，结果标记为「已过期」并停止着色（避免显示不同版本），
 * 重新运行后刷新。未展开诊断时一切交互与原来完全一致。
 */
type GapRunState =
  | { status: 'idle' }
  | {
      status: 'done'
      diagnosis: GapDiagnosis
      /** 结果所对应的输入签名（承诺原文 + 停用集合 + 模型）；不一致即过期。 */
      signature: string
    }
  | { status: 'failed'; reason: string }

function GapDiagnosisPanel({
  sinks,
  values,
  onChange,
  invalidNodes,
  runState,
  stale,
  onRun,
  onExportWitness,
}: {
  sinks: Model['network']['sinks']
  values: Record<string, string>
  onChange: (node: string, value: string) => void
  invalidNodes: string[]
  runState: GapRunState
  stale: boolean
  onRun: () => void
  onExportWitness: () => void
}) {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(sinks.length / COMMIT_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageSinks = sinks.slice(
    safePage * COMMIT_PAGE_SIZE,
    (safePage + 1) * COMMIT_PAGE_SIZE,
  )
  const shown = runState.status === 'done' && !stale ? runState.diagnosis : null

  return (
    <div className="interval-box">
      <p className="muted interval-note">
        当多项最低承诺无法同时兑现时，本诊断在<strong>总送水量仍等于当前网络最大
        供水量</strong>的全部方案中，把各安置点未达承诺量之和压到最小，并给出
        总缺口、逐点实际供水/缺口与一份满足全部容量与守恒约束的流量见证。
        填写承诺后点击「运行诊断」才提交；结果不会把各点单独上限拼成虚假方案。
      </p>

      <table className="data-table commit-table">
        <thead>
          <tr>
            <th>需求点</th>
            <th className="num">需求容量</th>
            <th>最低供水承诺</th>
            {shown && <th className="num">实际供水（见证）</th>}
            {shown && <th className="num">缺口</th>}
          </tr>
        </thead>
        <tbody>
          {pageSinks.map((k) => {
            const row = shown?.allocations.find((a) => a.sinkNode === k.node)
            const invalid = invalidNodes.includes(k.node)
            return (
              <CommitmentRow
                key={k.node}
                node={k.node}
                capacity={k.capacity}
                value={values[k.node] ?? ''}
                invalid={invalid}
                onChange={onChange}
                extra={
                  shown && row ? (
                    <>
                      <td className="num mono">
                        {formatInt(row.delivered)}
                      </td>
                      <td
                        className={`num mono${row.gap > 0 ? ' gap-cell' : ''}`}
                      >
                        {row.gap > 0 ? formatInt(row.gap) : '0'}
                      </td>
                    </>
                  ) : undefined
                }
              />
            )
          })}
        </tbody>
      </table>
      {pageCount > 1 && (
        <div className="arc-toolbar">
          <span className="muted">
            共 {formatInt(sinks.length)} 个需求点 · 第 {safePage + 1} / {pageCount} 页
          </span>
          <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            上一页
          </button>
          <button
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)}
          >
            下一页
          </button>
        </div>
      )}

      <div className="arc-toolbar gap-actions">
        <button onClick={onRun} disabled={invalidNodes.length > 0}>
          运行诊断
        </button>
        {shown && (
          <button onClick={onExportWitness}>导出诊断见证 JSON</button>
        )}
        {invalidNodes.length > 0 && (
          <span className="commit-field-error" role="alert">
            存在无效承诺填写，请先修正
          </span>
        )}
      </div>

      {runState.status === 'failed' && (
        <p className="interval-error" role="alert">
          缺口诊断失败：{runState.reason}。已保留上次最大流、联合承诺裁决与停用
          管段状态不变。
        </p>
      )}
      {stale && runState.status === 'done' && (
        <p className="gap-stale" role="status">
          承诺填写或停用管段已变化：下方结果与网络着色为上次提交版本，已过期；
          重新「运行诊断」后刷新。
        </p>
      )}
      {shown && (
        <div className="gap-summary" role="status">
          <div className="value-row">
            <ValueBlock label="固定总送水量（= 最大供水量）" value={formatInt(shown.total)} />
            <ValueBlock label="最小总缺口" value={formatInt(shown.totalGap)} />
            <ValueBlock label="参与承诺点数" value={formatInt(shown.committed)} />
          </div>
          <p className="muted interval-note">
            逐点「实际供水」即见证流量，满足全部管段/供水/需求边容量与节点守恒；
            未承诺点缺口恒为 0。割项表与管段清单的着色与本结果同源。
          </p>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [loader, setLoader] = useState(initialLoaderState)
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  // 工程师当前选中的需求点节点 id（基线与演练共用一个选择）。
  const [selectedSink, setSelectedSink] = useState('')
  // 联合最低供水承诺：需求点节点 id → 输入框原文（''=留空）。载入新模型时清空。
  const [commitments, setCommitments] = useState<Record<string, string>>({})
  // 最小承诺缺口诊断的「已提交结果」（显式运行才产生；摘要/着色/导出共用它）。
  const [gapRun, setGapRun] = useState<GapRunState>({ status: 'idle' })
  // 文件读取令牌：单调递增，只有仍是在途读取的回填才会被采用。
  const fileToken = useRef(0)

  const model = loader.model

  // 编辑文本框：只更新草稿；在途文件读取随之作废，
  // 迟到的文件结果不得覆盖用户正在编辑的内容。
  const onDraftChange = (t: string) => {
    setLoader((prev) => reduceEditDraft(prev, t))
  }

  // 解析文本框内容：以当前草稿为准同步载入（默认来源 = 文本框）。
  const parseDraft = () => {
    setLoader((prev) => reduceLoad(prev, prev.draft))
  }

  // 载入内置示例：示例文本同步进文本框，并作废在途文件读取。
  const loadSample = () => {
    setLoader((prev) => reduceLoad(prev, SAMPLE_TEXT, { kind: 'sample' }))
  }

  // 选择文件：登记在途读取后异步回填。读取完成 / 失败都按令牌回填，
  // 期间任何更新的用户操作（编辑、解析、示例、新文件）都会使迟到结果被整体丢弃。
  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    fileToken.current += 1
    const token = fileToken.current
    setLoader((prev) => beginFileRead(prev, file.name, token))
    file.text().then(
      (content) =>
        setLoader((prev) =>
          settleFileRead(prev, token, { ok: true, text: content }),
        ),
      (err) =>
        setLoader((prev) =>
          settleFileRead(prev, token, {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
          }),
        ),
    )
  }

  // 模型更换（引用变化）时清空演练方案、联合承诺与已选需求点，从基线重新开始。
  // 载入新模型使旧选择失效：区间随之清除（由下方 useMemo 重算），承诺一并清空。
  // 读取 / 解析失败时模型引用不变，本重置不会触发，演练状态全部保留。
  const [prevModel, setPrevModel] = useState(model)
  // 模型版本号：每次成功载入新模型（引用变化）单调递增，供已提交诊断判定过期。
  const [modelGeneration, setModelGeneration] = useState(0)
  if (model !== prevModel) {
    setPrevModel(model)
    setModelGeneration((g) => g + 1)
    setDisabled(new Set())
    setFilter('')
    setPage(0)
    setSelectedSink('')
    setCommitments({})
    setGapRun({ status: 'idle' })
  }

  // 基线方案解（含建模边身份与正反残量），供区间分析复用。
  const baselineSolution: PlanSolution | null = useMemo(() => {
    if (!model) return null
    return solvePlan(model.network, new Set())
  }, [model])

  // 空方案直接复用基线解，保证「清空方案」逐项精确回到基线（引用相同）。
  const currentSolution: PlanSolution | null = useMemo(() => {
    if (!model) return null
    return disabled.size === 0
      ? baselineSolution
      : solvePlan(model.network, disabled)
  }, [model, disabled, baselineSolution])

  // 空方案直接复用基线结果，保证「清空方案」逐项精确回到基线。
  const analysis: Analysis | null = currentSolution
    ? currentSolution.analysis
    : null

  // 已选需求点在新模型中不存在（如载入新模型后）→ 选择落回第一个需求点；
  // 无需求点时留空（面板不渲染）。
  const effectiveSink =
    model && model.network.sinks.some((k) => k.node === selectedSink)
      ? selectedSink
      : model && model.network.sinks.length > 0
        ? model.network.sinks[0].node
        : ''

  // 区间求解就地容错：辅助求解失败时清除旧区间并提示，
  // 不抛错、不影响已成功的基线核算与演练结果。
  const computeInterval = (
    solution: PlanSolution | null,
    nodeId: string,
  ): { interval: SinkInterval | null; failed: string | null } => {
    if (!solution || !nodeId) return { interval: null, failed: null }
    try {
      const result = sinkIntervalByNode(solution, nodeId)
      if (result.ok) {
        const interval: SinkInterval = {
          sinkNode: result.sinkNode,
          current: result.current,
          min: result.min,
          max: result.max,
          total: result.total,
        }
        return { interval, failed: null }
      }
      return { interval: null, failed: result.reason }
    } catch (err) {
      return {
        interval: null,
        failed: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const baselineIntervalState = useMemo(
    () => computeInterval(baselineSolution, effectiveSink),
    [baselineSolution, effectiveSink],
  )

  // 停用/恢复管段后，已选需求点按新断管集合与当前总量重算；
  // 清空方案时 currentSolution === baselineSolution，区间恢复为基线区间。
  const currentIntervalState = useMemo(
    () =>
      disabled.size === 0
        ? baselineIntervalState
        : computeInterval(currentSolution, effectiveSink),
    [currentSolution, effectiveSink, disabled.size, baselineIntervalState],
  )

  // 承诺输入的统一解析：filled 为合法 (node,minimum)，invalidNodes 为无效填写点。
  // 联合裁决与最小缺口诊断共用这一份解析，避免同一输入得出不同结论。
  const parsedCommitments = useMemo(() => {
    const filled: { node: string; minimum: number }[] = []
    const invalidNodes: string[] = []
    if (!model) return { filled, invalidNodes }
    for (const k of model.network.sinks) {
      const raw = commitments[k.node]
      if (raw === undefined || raw.trim() === '') continue
      const parsed = parseCommitment(raw, k.capacity)
      if (parsed.kind !== 'ok') invalidNodes.push(k.node)
      else filled.push({ node: k.node, minimum: parsed.value })
    }
    return { filled, invalidNodes }
  }, [model, commitments])

  // 联合最低供水承诺裁决（仅当前演练；空方案时 currentSolution 即基线解）。
  // 随填写、停用/恢复管段、清空方案（solution 引用变化）重算；
  // 无效填写或辅助求解异常只清除联合裁决并就地提示，不影响其余结果。
  const jointVerdict: JointVerdict = useMemo(() => {
    if (!model || !currentSolution) return { kind: 'idle' }
    const { filled, invalidNodes } = parsedCommitments
    if (invalidNodes.length > 0) return { kind: 'invalid', invalidNodes }
    if (filled.length === 0) return { kind: 'idle' }
    try {
      const result = jointCommitmentByNode(currentSolution, filled)
      if (!result.ok) {
        return result.reason === 'joint-lower-bounds-infeasible'
          ? {
              kind: 'infeasible',
              total: currentSolution.analysis.value,
              committed: filled.length,
            }
          : { kind: 'failed', reason: result.reason }
      }
      return {
        kind: 'feasible',
        total: result.total,
        committed: result.committed,
      }
    } catch (err) {
      return {
        kind: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }, [model, currentSolution, parsedCommitments])

  const onCommitmentChange = (node: string, value: string) => {
    setCommitments((prev) => ({ ...prev, [node]: value }))
  }

  // 当前输入签名：模型、停用集合（已排序）、承诺原文、当前最大总量。
  // 已提交诊断只在签名一致时有效；任一变化即标记过期（停止着色与摘要同源展示）。
  const gapSignature = useMemo(() => {
    if (!model || !currentSolution) return ''
    const committed = model.network.sinks
      .map((k) => `${k.node}=${commitments[k.node] ?? ''}`)
      .join('|')
    return [
      modelGeneration,
      currentSolution.analysis.value,
      currentSolution.analysis.disabled.join(','),
      committed,
    ].join('#')
  }, [model, modelGeneration, currentSolution, commitments])

  // 显式提交：按当前承诺与当前网络运行一次诊断，固化为不可变结果。
  const runGapDiagnosis = () => {
    if (!model || !currentSolution) return
    if (parsedCommitments.invalidNodes.length > 0) return
    try {
      const result = minimumCommitmentGapByNode(
        currentSolution,
        parsedCommitments.filled,
      )
      if (!result.ok) {
        setGapRun({ status: 'failed', reason: result.reason })
        return
      }
      const diagnosis: GapDiagnosis = {
        total: result.total,
        totalGap: result.totalGap,
        committed: result.committed,
        allocations: result.allocations,
        witness: result.witness,
      }
      setGapRun({ status: 'done', diagnosis, signature: gapSignature })
    } catch (err) {
      setGapRun({
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // 已提交且仍与当前输入一致的诊断（摘要与网络着色唯一数据源）。
  const activeDiagnosis: GapDiagnosis | null =
    gapRun.status === 'done' && gapRun.signature === gapSignature
      ? gapRun.diagnosis
      : null
  const gapStale = gapRun.status === 'done' && gapRun.signature !== gapSignature

  // 见证流量按边 id 建图（管段 / 需求点），供割项表与管段清单同源着色。
  const witnessFlowById = useMemo(() => {
    const map = new Map<string, { flow: number; capacity: number; kind: CutKind }>()
    if (!activeDiagnosis) return map
    for (const w of activeDiagnosis.witness.edges) {
      map.set(`${w.kind}:${w.id}`, {
        flow: w.flow,
        capacity: w.capacity,
        kind: w.kind,
      })
    }
    return map
  }, [activeDiagnosis])

  // 承诺缺口按需求点节点 id（割项表中的需求点项着色用）。
  const gapBySinkNode = useMemo(() => {
    const map = new Map<string, number>()
    if (activeDiagnosis) {
      for (const a of activeDiagnosis.allocations) map.set(a.sinkNode, a.gap)
    }
    return map
  }, [activeDiagnosis])

  const exportGapWitness = () => {
    if (!activeDiagnosis || !model || !currentSolution) return
    downloadJson('gap-diagnosis-witness.json', {
      report: 'gap-diagnosis',
      generatedAt: new Date().toISOString(),
      network: model.network,
      disabledArcIds: currentSolution.analysis.disabled,
      total: activeDiagnosis.total,
      totalGap: activeDiagnosis.totalGap,
      allocations: activeDiagnosis.allocations,
      witness: activeDiagnosis.witness,
    })
  }

  // 管段/割项着色等级（与已提交诊断同源；无诊断时不着色）。
  const arcTone = (
    kind: CutKind,
    id: string,
  ): 'none' | 'flow' | 'saturated' | 'short' => {
    if (!activeDiagnosis) return 'none'
    if (kind === 'sink') {
      const gap = gapBySinkNode.get(id) ?? 0
      return gap > 0 ? 'short' : 'flow'
    }
    const w = witnessFlowById.get(`${kind}:${id}`)
    if (!w) return 'none'
    if (w.capacity > 0 && w.flow === 0) return 'none'
    return w.flow >= w.capacity && w.capacity > 0 ? 'saturated' : 'flow'
  }

  const filteredArcs = useMemo(() => {
    if (!model) return []
    const f = filter.trim()
    if (!f) return model.network.arcs
    return model.network.arcs.filter(
      (a) => a.id.includes(f) || a.from.includes(f) || a.to.includes(f),
    )
  }, [model, filter])

  const pageCount = Math.max(1, Math.ceil(filteredArcs.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageArcs = filteredArcs.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  )

  const toggleArc = (id: string) => {
    const next = new Set(disabled)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setDisabled(next)
  }

  const clearPlan = () => setDisabled(new Set())

  return (
    <div className="page">
      <header className="page-header">
        <h1>暴雨断管 · 应急供水韧性评估</h1>
        <p className="muted">
          载入管网 JSON，核算基线最大供水量与瓶颈割项；逐项停用管段演练，
          实时得到当前供水量、相对损失与新割项。纯前端计算，无任何网络请求。
        </p>
      </header>

      <section className="card">
        <h2>一、载入网络</h2>
        <div className="load-actions">
          <label className="file-btn">
            选择 JSON 文件
            <input type="file" accept=".json,application/json" onChange={onFileChange} />
          </label>
          <button onClick={loadSample}>载入内置示例</button>
          <button onClick={parseDraft}>解析文本框内容</button>
        </div>
        <textarea
          className="json-input mono"
          spellCheck={false}
          placeholder='粘贴网络 JSON：{"nodes":[...],"arcs":[...],"sources":[...],"sinks":[...]}'
          value={loader.draft}
          onChange={(e) => onDraftChange(e.target.value)}
        />
        {loader.pendingFile && (
          <p className="muted" role="status">
            正在读取文件「{loader.pendingFile.name}」……完成前的其他载入操作将使本次读取作废。
          </p>
        )}
        {loader.error && (
          <div className="error-banner" role="alert">
            <strong className="mono">{loader.error.code}</strong>
            <span className="muted">
              {loader.errorSource
                ? `（被拒绝的输入：${sourceLabel(loader.errorSource)}；已保留上次模型、停用方案、需求点选择与联合承诺）`
                : '（已保留上次模型）'}
            </span>
            <ul>
              {loader.error.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
        )}
        {model ? (
          <p className="muted stats-line">
            当前模型：节点 {formatInt(model.network.nodes.length)} · 管段{' '}
            {formatInt(model.network.arcs.length)} · 供水点{' '}
            {model.network.sources.length} · 需求点 {model.network.sinks.length}
            {loader.modelSource && `（来源：${sourceLabel(loader.modelSource)}）`}
          </p>
        ) : (
          <p className="muted">尚未载入有效模型。</p>
        )}
        {loader.modelText !== null && loader.draft !== loader.modelText && (
          <p className="muted">
            文本框内容已被修改，与当前模型不一致；点击「解析文本框内容」将以文本框内容为准重新载入。
          </p>
        )}
      </section>

      {model && analysis && (
        <>
          <section className="card">
            <div className="card-head">
              <h2>二、基线核算</h2>
              <button
                onClick={() =>
                  downloadJson('baseline-report.json', buildReport('baseline', model, model.baseline))
                }
              >
                导出基线复核报告
              </button>
            </div>
            <div className="value-row">
              <ValueBlock
                label="基线最大供水量"
                value={formatInt(model.baseline.value)}
              />
              <ValueBlock
                label="割项数量"
                value={formatInt(model.baseline.cut.length)}
              />
            </div>
            <h3>残量网络源侧 → 汇侧割项</h3>
            <CutTable cut={model.baseline.cut} />

            {model.network.sinks.length > 0 && (
              <>
                <h3>避难点供水区间（基线）</h3>
                <SinkIntervalPanel
                  sinks={model.network.sinks}
                  selected={effectiveSink}
                  onSelect={setSelectedSink}
                  interval={baselineIntervalState.interval}
                  failed={baselineIntervalState.failed}
                />
              </>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>三、断管演练</h2>
              <div className="head-actions">
                <button onClick={clearPlan} disabled={disabled.size === 0}>
                  清空方案（回到基线）
                </button>
                <button
                  onClick={() =>
                    downloadJson('drill-report.json', buildReport('drill', model, analysis))
                  }
                >
                  导出演练复核报告
                </button>
              </div>
            </div>

            <div className="value-row">
              <ValueBlock
                label="当前最大供水量"
                value={formatInt(analysis.value)}
              />
              <ValueBlock
                label="绝对损失"
                value={formatInt(model.baseline.value - analysis.value)}
              />
              <ValueBlock
                label="相对损失"
                value={formatPercent(
                  relativeLoss(model.baseline.value, analysis.value),
                )}
              />
              <ValueBlock label="已停用管段" value={String(disabled.size)} />
            </div>
            {disabled.size === 0 && (
              <p className="muted">当前为空方案，结果与基线逐项一致。</p>
            )}
            {disabled.size > 0 && (
              <div className="chips">
                {analysis.disabled.map((id) => (
                  <button
                    key={id}
                    className="chip mono"
                    title="点击恢复该管段"
                    onClick={() => toggleArc(id)}
                  >
                    {id} ✕
                  </button>
                ))}
              </div>
            )}

            {model.network.sinks.length > 0 && (
              <>
                <h3>避难点供水区间（当前方案）</h3>
                <SinkIntervalPanel
                  sinks={model.network.sinks}
                  selected={effectiveSink}
                  onSelect={setSelectedSink}
                  interval={currentIntervalState.interval}
                  failed={currentIntervalState.failed}
                />
                {disabled.size === 0 && (
                  <p className="muted">空方案下区间与基线区间一致。</p>
                )}
              </>
            )}

            {model.network.sinks.length > 0 && (
              <>
                <h3>联合最低供水承诺（当前方案）</h3>
                <JointCommitmentPanel
                  sinks={model.network.sinks}
                  values={commitments}
                  verdict={jointVerdict}
                  onChange={onCommitmentChange}
                />

                <h3>最小承诺缺口诊断（显式提交）</h3>
                <GapDiagnosisPanel
                  sinks={model.network.sinks}
                  values={commitments}
                  onChange={onCommitmentChange}
                  invalidNodes={parsedCommitments.invalidNodes}
                  runState={gapRun}
                  stale={gapStale}
                  onRun={runGapDiagnosis}
                  onExportWitness={exportGapWitness}
                />
              </>
            )}

            {activeDiagnosis && (
              <p className="muted gap-legend" role="note">
                网络着色（与上方已提交诊断同源）：
                <span className="tone tone-flow">　</span> 有流量但未饱和的管段
                /已满足的需求点；
                <span className="tone tone-saturated">　</span> 饱和管段（瓶颈）；
                <span className="tone tone-short">　</span> 未达承诺的需求点。
              </p>
            )}

            <h3>当前割项</h3>
            <CutTable cut={analysis.cut} onDisableArc={toggleArc} toneOf={arcTone} />

            <h3>管段清单（勾选停用）</h3>
            <div className="arc-toolbar">
              <input
                type="search"
                placeholder="按 id / 起点 / 终点过滤"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value)
                  setPage(0)
                }}
              />
              <span className="muted">
                命中 {formatInt(filteredArcs.length)} 条 · 第 {safePage + 1} /{' '}
                {pageCount} 页
              </span>
              <button
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                上一页
              </button>
              <button
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              >
                下一页
              </button>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>停用</th>
                  <th>ID</th>
                  <th>起点 → 终点</th>
                  <th className="num">容量</th>
                  {activeDiagnosis && <th className="num">见证流量</th>}
                </tr>
              </thead>
              <tbody>
                {pageArcs.map((arc) => {
                  const isDisabled = disabled.has(arc.id)
                  const tone =
                    activeDiagnosis && !isDisabled ? arcTone('arc', arc.id) : 'none'
                  const w = activeDiagnosis
                    ? witnessFlowById.get(`arc:${arc.id}`)
                    : undefined
                  const rowClass = [
                    isDisabled ? 'row-disabled' : '',
                    tone !== 'none' ? `tone-row tone-${tone}` : '',
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <tr key={arc.id} className={rowClass || undefined}>
                      <td>
                        <input
                          type="checkbox"
                          checked={isDisabled}
                          onChange={() => toggleArc(arc.id)}
                        />
                      </td>
                      <td className="mono">{arc.id}</td>
                      <td className="mono">
                        {arc.from} → {arc.to}
                      </td>
                      <td className="num mono">{formatInt(arc.capacity)}</td>
                      {activeDiagnosis && (
                        <td className="num mono">
                          {isDisabled
                            ? '—（已停用）'
                            : w
                              ? `${formatInt(w.flow)} / ${formatInt(w.capacity)}`
                              : '—'}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        </>
      )}

      <footer className="muted footer">
        计算口径：超级源→供水点（供水能力）、原管段、需求点→超级汇（需求能力）的最大流；
        割项为残量网络中源侧可达集到汇侧的供水点/管段/需求点边，按类别与 id（UTF-16 升序）排列。
      </footer>
    </div>
  )
}
