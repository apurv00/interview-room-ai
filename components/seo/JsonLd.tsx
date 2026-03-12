interface JsonLdProps {
  data: Record<string, any>
}

export default function JsonLd({ data }: JsonLdProps) {
  // Replace </script> sequences to prevent breaking out of the script tag
  const safeJson = JSON.stringify(data).replace(/<\/script/gi, '<\\/script')
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: safeJson }}
    />
  )
}
