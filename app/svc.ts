// app/svc.ts — PocketCOM companion 通道适配层。
// 桌面宿主（--companions pocketcom --editor）把键盘/IME/鼠标/滚动以 JSON 行
// 逐 tick 投递进来；guest 侧每帧 poll 一次（PocketJS 帧契约，见 SPEC §4.3）。
// 参考 vendor/pocketjs/apps/note/svc.ts，companion id 换成 "pocketcom"。
// 无通道的宿主（sim、嵌入式）feature-detect 返回 null，app 退化为纯按键模式。

import { getOps } from "@pocketjs/framework";

export interface HostEvent {
  t: "hello" | "resize" | "ch" | "key" | "mouse" | "scroll" | "paste" | "ime";
  w?: number;
  h?: number;
  text?: string;
  s?: string;
  k?: string;
  x?: number;
  y?: number;
  /** 主键按下状态（mouse 事件）：每次按下/释放都会发一行，即使没移动。 */
  d?: boolean;
  /** 鼠标按键号（mouse 事件）：1 = 主键，2 = 右键（宿主 b:2 行）。 */
  b?: number;
  /** Shift 修饰（mouse/key）。 */
  sh?: boolean;
  /** 平台修饰键（Cmd，key 事件；宿主把未识别的 ⌘ 组合原样转发）。 */
  cmd?: boolean;
  /** Alt 修饰（key 事件）。 */
  alt?: boolean;
  /** Ctrl 修饰（key 事件）。 */
  ctl?: boolean;
  /** 滚轮增量，逻辑 px（scroll 事件）。 */
  dy?: number;
  /** IME preedit 光标（s 内的字符索引），composition 结束时为 null。 */
  c?: number | null;
}

export interface Svc {
  /** 取并解析本帧的宿主事件行（每帧调用一次）。 */
  poll(): HostEvent[];
  send(line: Record<string, unknown>): void;
}

/** 探测通道；返回 null 表示对端没有 companion 宿主。 */
export function connectSvc(): Svc | null {
  const ops = getOps();
  if (!ops.svcOpen || !ops.svcPoll || !ops.svcSend || !ops.svcOpen("pocketcom")) return null;
  const poll = ops.svcPoll.bind(ops);
  const send = ops.svcSend.bind(ops);
  return {
    poll() {
      const batch = poll();
      if (!batch) return [];
      const events: HostEvent[] = [];
      for (const line of batch.split("\n")) {
        if (line === "") continue;
        try {
          events.push(JSON.parse(line) as HostEvent);
        } catch {
          // 非法行是宿主 bug：跳过，不要卡死整帧。
        }
      }
      return events;
    },
    send(line) {
      send(JSON.stringify(line));
    },
  };
}
