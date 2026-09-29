import { Network } from './types'

/**
 * 内置示例：两座水厂（source-A/source-B）经主干管网向三处避难点
 * （sink-学校/sink-医院/sink-体育馆）供水，含重边（main-1/main-2）
 * 与反向回路，便于演示瓶颈定位与断管演练。
 */
export const SAMPLE_NETWORK: Network = {
  nodes: [
    { id: '水厂-甲' },
    { id: '水厂-乙' },
    { id: '枢纽-北' },
    { id: '枢纽-南' },
    { id: '避难-学校' },
    { id: '避难-医院' },
    { id: '避难-体育馆' },
  ],
  arcs: [
    { id: 'main-1', from: '水厂-甲', to: '枢纽-北', capacity: 40 },
    { id: 'main-2', from: '水厂-甲', to: '枢纽-北', capacity: 20 },
    { id: 'main-3', from: '水厂-乙', to: '枢纽-南', capacity: 55 },
    { id: 'link-1', from: '枢纽-北', to: '枢纽-南', capacity: 25 },
    { id: 'link-2', from: '枢纽-南', to: '枢纽-北', capacity: 10 },
    { id: 'feed-1', from: '枢纽-北', to: '避难-学校', capacity: 30 },
    { id: 'feed-2', from: '枢纽-北', to: '避难-医院', capacity: 25 },
    { id: 'feed-3', from: '枢纽-南', to: '避难-医院', capacity: 30 },
    { id: 'feed-4', from: '枢纽-南', to: '避难-体育馆', capacity: 35 },
    { id: 'spare-1', from: '避难-学校', to: '避难-医院', capacity: 5 },
  ],
  sources: [
    { node: '水厂-甲', capacity: 60 },
    { node: '水厂-乙', capacity: 55 },
  ],
  sinks: [
    { node: '避难-学校', capacity: 30 },
    { node: '避难-医院', capacity: 50 },
    { node: '避难-体育馆', capacity: 35 },
  ],
}

export const SAMPLE_TEXT = JSON.stringify(SAMPLE_NETWORK, null, 2)
