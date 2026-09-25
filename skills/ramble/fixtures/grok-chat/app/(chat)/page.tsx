// FIXTURE screen: chat home
export default function Home() {
  return (
    <main>
      <a href="/imagine">Imagine</a>
      <a href="/tasks">Tasks</a>
      <a href="/files">Files</a>
      <a href="/settings">Settings</a>
      <Link href={`/c/${chat.id}`}>Open chat</Link>
      <Link href={`/project/${project.id}`}>Open project</Link>
    </main>
  );
}
