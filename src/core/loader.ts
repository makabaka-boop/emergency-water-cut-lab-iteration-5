import { INVALID_NETWORK, LoadError, Model } from './types'
import { parseNetwork } from './validate'
import { analyze } from './analyze'

/**
 * 载入来源：文件（含文件名）/ 内置示例 / 文本框。
 * 当前模型与当前错误各自记录来源，页面可明确展示数据出自哪次输入。
 */
export type LoadSource =
  | { kind: 'file'; name: string }
  | { kind: 'sample' }
  | { kind: 'text' }

/**
 * 页面加载状态：模型与错误互斥地更新（非法输入保留上次模型）。
 *
 * 来源一致性约定：
 *  - draft 始终等于文本框内容；每次载入动作（文件 / 示例 / 解析）都把其实际输入
 *    同步进 draft，输入被拒绝时也不例外——错误详情因此始终对应文本框中可见的
 *    内容（文件读取失败时没有内容可同步，错误详情直接点名文件与原因）；
 *  - modelText / modelSource 记录产生当前模型的输入与来源；
 *    draft !== modelText 即「草稿已修改、尚未解析」，页面据此提示；
 *  - 失败的读取 / 解析只替换 error 与 errorSource，model、modelText、modelSource
 *    原样保留（引用不变），停用集合、需求点选择与联合承诺因此不受影响。
 */
export interface LoaderState {
  model: Model | null
  error: LoadError | null
  /** 文本草稿（= 文本框内容）。 */
  draft: string
  /** 产生当前模型的输入文本；无模型时为 null。 */
  modelText: string | null
  /** 当前模型的来源；无模型时为 null。 */
  modelSource: LoadSource | null
  /** 当前错误对应的被拒绝输入的来源；无错误时为 null。 */
  errorSource: LoadSource | null
  /**
   * 在途文件读取（token 由调用方单调分配）。任何更新的用户动作
   * （编辑草稿、解析文本、载入示例、选择新文件）都会将其清空：
   * 迟到的读取结果据此判旧并整体丢弃，只有最后一次用户操作决定结果。
   */
  pendingFile: { token: number; name: string } | null
}

export const initialLoaderState: LoaderState = {
  model: null,
  error: null,
  draft: '',
  modelText: null,
  modelSource: null,
  errorSource: null,
  pendingFile: null,
}

/**
 * 应用一次载入：
 *  - 合法 → 替换模型（并重算基线），清空错误；
 *  - 非法 → INVALID_NETWORK，原模型原样保留（引用不变）。
 * 两种情形都把实际输入同步进草稿，并作废在途文件读取。
 */
function applyLoad(
  state: LoaderState,
  text: string,
  source: LoadSource,
): LoaderState {
  const result = parseNetwork(text)
  if (!result.ok) {
    return {
      ...state,
      draft: text,
      error: result.error,
      errorSource: source,
      pendingFile: null,
    }
  }
  const network = result.network
  return {
    ...state,
    draft: text,
    modelText: text,
    modelSource: source,
    model: { network, baseline: analyze(network, new Set()) },
    error: null,
    errorSource: null,
    pendingFile: null,
  }
}

/**
 * 同步载入一段 JSON 文本（解析文本框内容 / 载入内置示例）：
 * 属于用户的一次明确操作，先于它发起的在途文件读取一律作废。
 */
export function reduceLoad(
  state: LoaderState,
  text: string,
  source: LoadSource = { kind: 'text' },
): LoaderState {
  return applyLoad(state, text, source)
}

/**
 * 编辑文本草稿：只更新草稿，不触碰模型与错误；
 * 同属用户操作，先于它发起的在途文件读取一律作废
 * （迟到的文件结果不得覆盖用户正在编辑的内容）。
 */
export function reduceEditDraft(
  state: LoaderState,
  draft: string,
): LoaderState {
  if (draft === state.draft && state.pendingFile === null) return state
  return { ...state, draft, pendingFile: null }
}

/**
 * 选择文件后开始异步读取：登记在途读取（token 由调用方单调分配，
 * 新一次登记会替换旧的）。读取完成 / 失败须以同一 token 调用
 * settleFileRead 回填。
 */
export function beginFileRead(
  state: LoaderState,
  name: string,
  token: number,
): LoaderState {
  return { ...state, pendingFile: { token, name } }
}

export type FileReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: string }

/**
 * 文件读取回填：
 *  - token 与在途读取不一致（期间已有更新的用户操作）→ 整体丢弃，状态原样返回；
 *  - 读取失败 → INVALID_NETWORK（详情点名文件与原因），模型与草稿原样保留；
 *  - 读取成功 → 以文件内容载入（同步进文本草稿），非法内容按非法输入处理。
 */
export function settleFileRead(
  state: LoaderState,
  token: number,
  result: FileReadResult,
): LoaderState {
  const pending = state.pendingFile
  if (!pending || pending.token !== token) return state
  if (!result.ok) {
    return {
      ...state,
      pendingFile: null,
      error: {
        code: INVALID_NETWORK,
        details: [`文件 "${pending.name}" 读取失败：${result.reason}`],
      },
      errorSource: { kind: 'file', name: pending.name },
    }
  }
  return applyLoad(state, result.text, { kind: 'file', name: pending.name })
}
