# AIC 接收日志触摸拖动修复（2026-10-26）

## 根因与修改

`ReceivePane` 只订阅 `onWheel("log")`，桌面 companion 鼠标拖动用于日志文本选区。
AIC 接触点经框架触摸通道进入 JS，不生成 companion 滚轮事件，因此有超出视口的日志时，手指拖动仍不改变日志偏移。

共享接收区增加 `createGesture` 纵向 pan，绑定裁剪的日志内容节点与同源屏幕几何，复用滚轮的边界钳位与贴底状态。
下拉、连接抽屉、设置及软键盘显示时拒绝起手并取消进行中手势，工具栏与发送区不属于手势子树。
滚轮回调在组件卸载时注销；桌面鼠标选区保留。SPEC §3.3 同步补充触摸语义；功能配置、堆容量及接收历史上限未调整。

## 验证

- 新增 `test/app/receive-touch.test.ts`，以 JSON `aic-diagnostic` 编译真实 Vue Vapor，用 native core WASM 的 bounds down-edge fact 输入连续触摸。
- 修复前同一测试在首次向下拖动处失败：日志画布偏移保持 -646；修复后通过。
- 覆盖跟手滚动、上下边界、横向拖动拒绝、工具栏/发送区隔离、历史锁定、回到底部恢复跟随、打开抽屉中断手势、抽屉/下拉/设置遮挡，以及折叠发送区后新增可视区域可拖动。
- 接收触摸、连接面板触摸、串口时钟、软键盘（AIC/ui-on/ui-off）、发送区复用、滚轮生命周期共 11 项回归通过；新增设置遮挡断言后接收测试再次通过。
- `npm run typecheck`、`git diff --check` 通过；`npm run build:aic` 成功并通过静态预算。

## 产物与验收边界

固定副本在 `dist/aic/receive-touch-fix/`：`d12x_os.itb`、`pocketcom-aic.pocket`、`memory-report.json`、`build.log`。

- 应用包 828,616 bytes；OS 镜像 3,000,320 / 3,145,728 bytes，余量 145,408 bytes。
- ITB SHA-256：`ddfd738e061c0b7b903e8f9d7876a6c3d070ee061364738eabb23c90e2d8dac2`。
- package SHA-256：`c38c5bcfe4faacf5b12ffa593cd0faf904113b24c1b688edaeae43cfbbcf535f`。

尚未烧录；WASM 交互回归与静态预算不代表实际 AIC 包的 QuickJS/native 连续触摸或真机内存验收。
真机需先发送足够多的换行数据至日志溢出可视高度，再在接收内容区上下拖动；确认上翻期间新接收不拉回底部、拖回底部恢复跟随，并检查打开抽屉/设置后日志不随之滚动。
