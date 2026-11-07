export const escapeLike=(value:string)=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%'
export const searchPatterns=(value:string)=>/^#?[1-9]\d{0,9}$/.test(value.trim())?[value.trim().replace(/^#/,'')]:value.trim().split(/\s+/).filter(Boolean).map(escapeLike)
/** Field names are fixed server code, never request input. */
export const matching=(fields:string[])=>'NOT EXISTS (SELECT 1 FROM unnest($1::text[]) AS terms(term) WHERE NOT COALESCE(('+fields.map(field=>'('+field+' COLLATE "pg_c_utf8") ILIKE term').join(' OR ')+'),false))'
