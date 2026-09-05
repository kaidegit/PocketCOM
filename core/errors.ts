/**
 * 核心层错误分类（SPEC §5.1）：ParamError / StateError / IoError / ProtocolError，
 * 均携带结构化 `code` 字段，UI/MCP 各按 code 映射展示，不以裸字符串充当错误。
 */

export type ErrorCode =
  // ParamError：用户输入 / 参数非法
  | "PARAM_HEX_INVALID"
  | "PARAM_HEX_ODD_LENGTH"
  | "PARAM_ESCAPE_INVALID"
  | "PARAM_INVALID"
  // StateError：状态机非法迁移等
  | "STATE_ILLEGAL_TRANSITION"
  // IoError：连接读写失败
  | "IO_WRITE_FAILED"
  | "IO_READ_FAILED"
  | "IO_CONNECT_FAILED"
  // ProtocolError：对端协议违规
  | "PROTOCOL_VIOLATION";

/** 核心层错误基类：所有 PocketCOM 核心错误都带结构化 code。 */
export class PocketError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

/** 参数非法（如 hex 串格式错误、转义序列非法）。 */
export class ParamError extends PocketError {}

/** 状态非法（如连接状态机收到不允许的迁移）。 */
export class StateError extends PocketError {}

/** IO 失败（连接写入/读取失败，经 conn.error 上报后转 LOST，不 crash）。 */
export class IoError extends PocketError {}

/** 协议违规（对端数据违反协议约定）。 */
export class ProtocolError extends PocketError {}
