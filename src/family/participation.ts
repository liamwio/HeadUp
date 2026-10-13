export const PARTICIPATION_LABELS={together:'家长和孩子一起',parent:'家长安排记录',child:'孩子与家长共同确认'} as const
export type Participation=keyof typeof PARTICIPATION_LABELS
export const isParticipation=(value:unknown):value is Participation=>typeof value==='string'&&Object.hasOwn(PARTICIPATION_LABELS,value)
