export function publicNumber(value:string){
 const clean=value.trim().replace(/^#/,'')
 if(!/^[1-9]\d{0,9}$/.test(clean))return null
 const number=Number(clean)
 return number<=2147483647?number:null
}
