import {it,expect} from 'vitest'
import {renderToStaticMarkup} from 'react-dom/server'
import {CameraFramingGuide,captureGuideGeometry} from './CameraFramingGuide'
it.each([[1920,1080],[1080,1920],[640,480]])('keeps an undistorted target inside %ix%i camera content', (width,height)=>{
  const g=captureGuideGeometry(width,height)
  expect(g.x+60*g.scale).toBeGreaterThan(0);expect(g.x+240*g.scale).toBeLessThan(width)
  expect(g.y+18*g.scale).toBeGreaterThan(0);expect(g.y+332*g.scale).toBeLessThan(height)
  const html=renderToStaticMarkup(<CameraFramingGuide width={width} height={height} view="front" ready={false}/>)
  expect(html).toContain(`viewBox="0 0 ${width} ${height}"`);expect(html).toContain('xMidYMid meet')
})
it('mirrors only the target side silhouette, never the detected face geometry',()=>{
  const html=renderToStaticMarkup(<CameraFramingGuide width={640} height={480} view="profile" side="right_profile" ready={true} pose={{status:'pass',estimatedPose:'right_profile',detectedFaces:1,flags:[],faceBounds:{x:.3,y:.25,width:.4,height:.5}}}/>)
  expect(html).toContain('右侧头部取景框');expect(html).toContain('translate(300 0) scale(-1 1)');expect(html).toContain('x="192" y="120" width="256" height="240"')
})
