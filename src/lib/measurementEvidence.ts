export type EvidencePoint={id:string;label:string;x:number;y:number}
export type EvidenceSegment={id:string;label:string;from:string;to:string;role:'measure'|'reference'|'projection'}
/** Pixel coordinates refer to the saved analysis image, never the CSS viewport. */
export type MeasurementEvidence={version:'HEADUP-POINT-LINE-1';source:'saved_front_landmarks'|'saved_profile_landmarks';width:number;height:number;points:EvidencePoint[];segments:EvidenceSegment[];formula:string}
