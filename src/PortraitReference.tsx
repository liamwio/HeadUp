/** Illustration anchors in the supplied 759 × 644 portrait's pixel coordinates.
 * Image and guides share one SVG transform, including responsive cover cropping.
 * These guides are manually placed presentation annotations, not model outputs.
 */
export function PortraitReference({ profile = false, focusFace = false, showLines = true }: { profile?: boolean; focusFace?:boolean; showLines?:boolean }) {
  return <svg className="portrait-reference" viewBox={profile ? '435 90 324 360' : focusFace?'140 55 300 400':'0 0 759 644'} preserveAspectRatio={profile ? 'xMinYMid slice' : 'xMidYMid slice'} role="img" aria-label={profile ? '侧面照片与对齐的轮廓示意线' : '正面照片与对齐的比例示意线'}>
    <image href="/assets/headup-front-profile-hero.webp" width="759" height="644" />
    {showLines&&(profile ? <g className="portrait-reference__profile">
      <path stroke="#83cfff" d="M507 143 C499 166 497 185 501 207 C504 220 505 230 500 242" />
      <path stroke="#ffd166" d="M500 242 C496 258 487 274 478 287 C473 294 477 301 491 306" />
      <path stroke="#d6a4ff" d="M491 306 C503 305 505 312 499 321 L493 326" />
      <path stroke="#7ce6a5" d="M506 365 C504 379 502 392 513 399 C528 410 554 395 577 393 C603 387 623 362 641 335" />
      <path className="portrait-reference__eline" d="M477 296 L508 397" />
      {[[500,242],[477,296],[491,306],[493,326],[500,354],[508,397],[641,335]].map(([cx,cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.5" />)}
    </g> : <g className="portrait-reference__front">
      <path className="portrait-reference__outline" d="M196 194 C177 224 187 286 203 324 C222 369 258 405 289 409 C326 410 363 378 383 332 C400 291 410 238 397 207" />
      <path className="portrait-reference__guides" d="M190 236 H401 M209 307 H379 M231 348 H355 M259 401 H326 M295 157 V409" />
      {[[245,236],[347,236],[280,307],[310,307],[261,348],[328,348],[295,348],[289,409]].map(([cx,cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3" />)}
    </g>)}
  </svg>
}
