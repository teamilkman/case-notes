// Only the immutable line array is compressed. Commit-time metadata remains
// SQL JSON, so the receipt still captures the exact state of its transaction.
export async function storeReceipt(receipt:any):Promise<string> {
  const lines=receipt.data.lines;
  if(!Array.isArray(lines))return JSON.stringify(receipt);
  const raw=JSON.stringify(lines),bytes=new TextEncoder().encode(raw);
  if(bytes.length<1024)return JSON.stringify(receipt);
  const compressed=new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  let binary='';for(let n=0;n<compressed.length;n+=32768)binary+=String.fromCharCode(...compressed.subarray(n,n+32768));
  const encoded=btoa(binary);
  if(encoded.length+64>=bytes.length)return JSON.stringify(receipt);
  const data={...receipt.data};delete data.lines;
  return JSON.stringify({...receipt,data,_receipt_lines_gzip:encoded});
}
export async function readReceipt(json:string):Promise<any> {
  const receipt=JSON.parse(json);
  if(typeof receipt._receipt_lines_gzip==='string'){
    const bytes=Uint8Array.from(atob(receipt._receipt_lines_gzip),c=>c.charCodeAt(0));
    const raw=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    receipt.data.lines=JSON.parse(raw);delete receipt._receipt_lines_gzip;
  }
  return receipt;
}
