import type { Capture } from '../types'

export function revokeCaptureImages(capture:Pick<Capture,'url'|'originalUrl'>) {
  for(const url of new Set([capture.url,capture.originalUrl]))if(url)URL.revokeObjectURL(url)
}
