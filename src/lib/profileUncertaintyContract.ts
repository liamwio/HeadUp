const metric=(manualP95:number,pairedDifferenceP95:number)=>({manualP95,pairedDifferenceP95,rss:Math.hypot(manualP95,pairedDifferenceP95)})

/** P95 values in display units for the deployed direct-geometry core readings. */
export const DIRECT_PROFILE_UNCERTAINTY={
  convexityDegrees:metric(16.30,7.80),
  eLineUpperPercentagePoints:metric(4.10,1.50),
  eLineLowerPercentagePoints:metric(4.40,1.50),
  nasolabialDegrees:metric(24.20,9.58),
  mentolabialDegrees:metric(28.50,11.15),
  chinProjectionPercentagePoints:metric(13.50,5.11),
  mandibularInclinationDegrees:metric(9.40,4.05),
  verticalMidfacePercentagePoints:metric(5.40,2.01),
  verticalLowerFacePercentagePoints:metric(5.50,2.01),
}as const

/** P95 values for readings recomputed from the deployed refined Menpo39 overlay points. */
export const OVERLAY_PROFILE_UNCERTAINTY={
  nasolabialDegrees:metric(26.13,10.57),
  upperLipELinePercentagePoints:metric(5.19,1.71),
  verticalPercentagePoints:metric(6.06,2.73),
  mandibularInclinationDegrees:metric(10.40,5.37),
  chinProjectionPercentagePoints:metric(12.66,5.53),
}as const

/** Aggregate disagreement values use the maximum component, so their gate uses the larger component RSS. */
export const DIRECT_PROFILE_DISAGREEMENT_LIMITS={
  softTissueConvexityAngleDegrees:DIRECT_PROFILE_UNCERTAINTY.convexityDegrees.rss,
  eLinePercentagePoints:Math.max(DIRECT_PROFILE_UNCERTAINTY.eLineUpperPercentagePoints.rss,DIRECT_PROFILE_UNCERTAINTY.eLineLowerPercentagePoints.rss),
  nasolabialAngleDegrees:DIRECT_PROFILE_UNCERTAINTY.nasolabialDegrees.rss,
  mentolabialAngleDegrees:DIRECT_PROFILE_UNCERTAINTY.mentolabialDegrees.rss,
  chinProjectionPercentagePoints:DIRECT_PROFILE_UNCERTAINTY.chinProjectionPercentagePoints.rss,
  mandibularInclinationDegrees:DIRECT_PROFILE_UNCERTAINTY.mandibularInclinationDegrees.rss,
  verticalPercentagePoints:Math.max(DIRECT_PROFILE_UNCERTAINTY.verticalMidfacePercentagePoints.rss,DIRECT_PROFILE_UNCERTAINTY.verticalLowerFacePercentagePoints.rss),
}as const
