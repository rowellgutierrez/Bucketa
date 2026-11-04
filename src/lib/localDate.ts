/** Calendar keys use the user's local timezone; stored timestamps stay untouched. */
export function localDateKey(date:Date):string{return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');}
export function timestampLocalDate(value:string):string{return /^\d{4}-\d{2}-\d{2}$/.test(value)?value:localDateKey(new Date(value));}
