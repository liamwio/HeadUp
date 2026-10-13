import { inspectWidePoseAndFaces } from './lib/captureAnalysis'
import {
  advanceActiveChallenge,
  createActiveChallenge,
  type ActiveChallengeState,
  type ChallengeTarget,
} from './lib/activeChallenge'

const video = document.querySelector<HTMLVideoElement>('#camera')!
const canvas = document.querySelector<HTMLCanvasElement>('#capture')!
const prompt = document.querySelector<HTMLElement>('#prompt')!
const status = document.querySelector<HTMLElement>('#status')!
const startButton = document.querySelector<HTMLButtonElement>('#start')!
const stopButton = document.querySelector<HTMLButtonElement>('#stop')!

let stream: MediaStream | null = null
let challenge: ActiveChallengeState | null = null
let loopTimer: number | null = null
let running = false

const TARGET_TEXT: Record<ChallengeTarget, string> = {
  center: '正面看镜头 · 保持不动',
  positive_yaw: '鼻尖转向屏幕左侧 ←',
  negative_yaw: '鼻尖转向屏幕右侧 →',
}

const FAILURE_TEXT: Record<string, string> = {
  invalid_frame: '姿态模型返回了无效结果',
  non_monotonic_frame_time: '摄像头时间戳异常',
  frame_gap_too_large: '设备分析速度不足或摄像头中断',
  overall_timeout: '没有在 20 秒内完成全部动作',
  step_timeout: '当前动作没有在规定时间内完成',
}

function randomOrder(): ActiveChallengeState['order'] {
  const sample = new Uint32Array(1)
  crypto.getRandomValues(sample)
  return sample[0] % 2 === 0 ? 'positive_first' : 'negative_first'
}

function stopCamera() {
  if (loopTimer !== null) window.clearTimeout(loopTimer)
  loopTimer = null
  running = false
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  video.srcObject = null
  stopButton.disabled = true
  startButton.disabled = false
}

function clearStudy(message = '已停止，摄像头和本页内存结果均已清空。') {
  stopCamera()
  challenge = null
  prompt.textContent = '点击“开始随机挑战”重新测试'
  status.className = 'status'
  status.textContent = message
}

async function snapshot(): Promise<File> {
  if (!video.videoWidth || !video.videoHeight) throw new Error('摄像头画面尚未就绪')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建本地帧缓冲区')
  context.drawImage(video, 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error('无法读取摄像头帧')), 'image/jpeg', 0.9)
  })
  return new File([blob], 'memory-frame.jpg', { type: blob.type })
}

function renderRunning(faceCount: number, yaw: number, roll: number) {
  if (!challenge || challenge.status !== 'running') return
  const target = challenge.targets[challenge.stepIndex]
  prompt.textContent = `${challenge.stepIndex + 1} / ${challenge.targets.length} · ${TARGET_TEXT[target]}`
  status.className = 'status'
  const evidence = faceCount === 1
    ? `检测：单人脸 · yaw ${yaw.toFixed(1)}° · roll ${roll.toFixed(1)}°`
    : `检测：${faceCount === 0 ? '未找到合格人脸' : `${faceCount} 张人脸（只允许一人）`}`
  status.textContent = `${evidence}\n当前动作需稳定保持至少 250 ms；原始帧和角度不会保存。`
}

function finish() {
  if (!challenge) return
  if (challenge.status === 'passed') {
    prompt.textContent = '挑战完成'
    status.className = 'status pass'
    status.textContent = '已按随机顺序完成 5 个姿态步骤。此结果只代表主动交互研究通过；真实多角度帧按指令注入曾通过 22/30 次，虚拟摄像头注入曾通过 11/15 次，不代表商业级活体认证。'
  } else {
    prompt.textContent = '挑战未通过'
    status.className = 'status reject'
    const reason = challenge.failureReason ? FAILURE_TEXT[challenge.failureReason] ?? challenge.failureReason : '未知原因'
    status.textContent = `失败原因：${reason}。没有保存任何摄像头帧或逐帧分析数据，可重新开始。`
  }
  stopCamera()
}

async function analyzeNextFrame() {
  if (!running || !challenge) return
  try {
    const file = await snapshot()
    const { pose, faceSummary } = await inspectWidePoseAndFaces(file)
    if (!running || !challenge) return
    const eligible = faceSummary.detections.filter((detection) => detection.score >= 0.6)
    const best = eligible.sort((left, right) => right.score - left.score)[0]
    const timestampMs = performance.now()
    challenge = advanceActiveChallenge(challenge, {
      timestampMs,
      yaw: pose.yaw,
      roll: pose.roll,
      faceCount: eligible.length,
      faceScore: best?.score ?? 0,
      faceAreaRatio: best?.areaRatio ?? 0,
      faceCenterDistance: best?.centerDistance ?? 1,
    })
    renderRunning(eligible.length, pose.yaw, pose.roll)
    if (challenge.status !== 'running') {
      finish()
      return
    }
    loopTimer = window.setTimeout(() => void analyzeNextFrame(), 300)
  } catch (error) {
    if (!running) return
    status.className = 'status reject'
    status.textContent = `本地分析失败：${error instanceof Error ? error.message : '未知错误'}。摄像头帧没有保存。`
    stopCamera()
  }
}

async function startStudy() {
  clearStudy('正在申请前置摄像头权限…')
  startButton.disabled = true
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
    })
    video.srcObject = stream
    await video.play()
    challenge = createActiveChallenge(randomOrder())
    running = true
    stopButton.disabled = false
    prompt.textContent = `1 / 5 · ${TARGET_TEXT.center}`
    status.className = 'status'
    status.textContent = '模型首次加载可能需要数秒；请保持正面、单人入镜。'
    void analyzeNextFrame()
  } catch (error) {
    clearStudy(`无法启动摄像头：${error instanceof Error ? error.message : '权限被拒绝或设备不可用'}`)
  }
}

startButton.addEventListener('click', () => void startStudy())
stopButton.addEventListener('click', () => clearStudy())
window.addEventListener('pagehide', stopCamera)
window.addEventListener('beforeunload', stopCamera)
startButton.dataset.challengeReady = 'true'
