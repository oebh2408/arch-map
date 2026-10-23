export function Button({ children }: { children: React.ReactNode }) {
  return <button className="btn">{children}</button>;
}

export function Card({ title }: { title: string }) {
  return <section className="card"><h2>{title}</h2></section>;
}
