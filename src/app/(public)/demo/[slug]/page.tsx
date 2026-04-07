export default function DemoViewerPage({ params }: { params: { slug: string } }) {
  return <div>Demo Viewer: {params.slug}</div>;
}
