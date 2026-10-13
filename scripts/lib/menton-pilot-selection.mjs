export function percentile(values, fraction) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.round((sorted.length - 1) * fraction)]
}

export function distribution(values) {
  return {
    min: percentile(values, 0),
    p05: percentile(values, 0.05),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: percentile(values, 1),
  }
}

function normalizedVectors(items) {
  const dimensions = items[0].features.length
  const minima = Array.from({ length: dimensions }, (_, index) => Math.min(...items.map((item) => item.features[index])))
  const maxima = Array.from({ length: dimensions }, (_, index) => Math.max(...items.map((item) => item.features[index])))
  return new Map(items.map((item) => [item.subjectIndex, item.features.map((value, index) => {
    const range = maxima[index] - minima[index]
    return range > 1e-12 ? (value - minima[index]) / range : 0
  })]))
}

function distance(left, right) {
  return Math.sqrt(left.reduce((sum, value, index) => sum + (value - right[index]) ** 2, 0))
}

export function selectMaximin(items, count) {
  if (!Number.isInteger(count) || count < 1 || count > items.length) throw new Error('invalid maximin count')
  if (!items.length || items.some((item) => !Number.isInteger(item.subjectIndex)
    || !Array.isArray(item.features) || !item.features.length
    || item.features.some((value) => !Number.isFinite(value))
    || typeof item.tiebreaker !== 'string')) throw new Error('invalid maximin records')
  if (new Set(items.map((item) => item.subjectIndex)).size !== items.length) throw new Error('duplicate subjects')
  const vectors = normalizedVectors(items)
  const ordered = [...items].sort((a, b) => a.tiebreaker.localeCompare(b.tiebreaker))
  const selected = [ordered[0]]
  const remaining = new Map(ordered.slice(1).map((item) => [item.subjectIndex, item]))
  while (selected.length < count) {
    const ranked = [...remaining.values()].map((item) => ({
      item,
      minimumDistance: Math.min(...selected.map((chosen) => distance(
        vectors.get(item.subjectIndex), vectors.get(chosen.subjectIndex),
      ))),
    })).sort((left, right) => right.minimumDistance - left.minimumDistance
      || left.item.tiebreaker.localeCompare(right.item.tiebreaker))
    const next = ranked[0].item
    selected.push(next)
    remaining.delete(next.subjectIndex)
  }
  return selected
}

export function selectStratifiedPilot(subjects, perQuartile = 15) {
  if (subjects.length !== 200 || new Set(subjects.map((item) => item.subjectIndex)).size !== 200) {
    throw new Error('expected exactly 200 FEI subjects')
  }
  const selected = []
  for (let quartile = 0; quartile < 4; quartile++) {
    const minimum = quartile * 50 + 1
    const maximum = minimum + 49
    const stratum = subjects.filter((item) => item.subjectIndex >= minimum && item.subjectIndex <= maximum)
    if (stratum.length !== 50) throw new Error(`incomplete FEI subject quartile ${quartile + 1}`)
    selected.push(...selectMaximin(stratum, perQuartile).map((item) => ({ ...item, quartile: quartile + 1 })))
  }
  return selected
}

export function featureRangeCoverage(allSubjects, selectedSubjects) {
  const names = ['brightness', 'contrast', 'edgeSharpness', 'sideBrightnessDifference', 'sideSharpnessDifference']
  return Object.fromEntries(names.map((name, index) => {
    const fullValues = allSubjects.map((item) => item.features[index])
    const selectedValues = selectedSubjects.map((item) => item.features[index])
    const fullRange = Math.max(...fullValues) - Math.min(...fullValues)
    const selectedRange = Math.max(...selectedValues) - Math.min(...selectedValues)
    return [name, {
      full: distribution(fullValues),
      selected: distribution(selectedValues),
      rangeCoverage: fullRange > 1e-12 ? selectedRange / fullRange : 1,
    }]
  }))
}
