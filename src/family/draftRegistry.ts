/** Multiple independent editors may be mounted on one record page. */
export class DraftRegistry{
  private entries=new Set<string>()
  set(id:string,dirty:boolean){if(dirty)this.entries.add(id);else this.entries.delete(id);return this.hasDraft()}
  hasDraft(){return this.entries.size>0}
  clear(){this.entries.clear()}
}
