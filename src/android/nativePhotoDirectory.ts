import {configurePhotoDirectory} from '../family/photoDirectory'
/** App-only branch: never register a native photo writer or resume directory jobs. */
export function installNativePhotoDirectory(){configurePhotoDirectory(undefined)}
