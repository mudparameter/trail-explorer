declare module '*.css';
declare module '*?url' {
  const url: string;
  export default url;
}
declare module '*?inline' {
  const text: string;
  export default text;
}
