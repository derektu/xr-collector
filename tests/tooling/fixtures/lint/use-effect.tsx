import React, { useEffect, useLayoutEffect } from 'react';

export function Title({ text }: { text: string }) {
  useEffect(() => { document.title = text; }, [text]);
  useLayoutEffect(() => undefined, []);
  React.useEffect(() => undefined, []);
  React.useLayoutEffect(() => undefined, []);
  return <h1>{text}</h1>;
}
