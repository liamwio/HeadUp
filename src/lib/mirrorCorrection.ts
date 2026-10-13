import { preflightImageFile } from './imageInputPreflight'

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('无法生成镜像纠正图片，请更换原图')),
    'image/png',
  ))
}

export async function correctMirroredFrontFile(file: File): Promise<File> {
  await preflightImageFile(file)
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前浏览器无法执行镜像纠正')
    context.translate(bitmap.width, 0)
    context.scale(-1, 1)
    context.drawImage(bitmap, 0, 0)
    const blob = await pngBlob(canvas)
    const stem = file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'front'
    return new File([blob], `${stem}-mirror-corrected.png`, { type: 'image/png', lastModified: file.lastModified })
  } finally {
    bitmap.close()
  }
}
