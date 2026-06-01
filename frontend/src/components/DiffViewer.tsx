import React, { useMemo } from 'react'
import { diffWords } from 'diff'

interface DiffViewerProps {
  oldText: string
  newText: string
}

export const DiffViewer: React.FC<DiffViewerProps> = ({ oldText, newText }) => {
  const parts = useMemo(() => diffWords(oldText, newText), [oldText, newText])

  return (
    <div
      style={{
        fontFamily: 'inherit',
        fontSize: '0.9rem',
        lineHeight: '1.8',
        color: '#1a1a1a',
        padding: '1.5rem',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
      }}
    >
      {parts.map((part, i) => {
        if (part.added) {
          return (
            <ins
              key={i}
              style={{
                background: '#d4f7d4',
                color: '#1a6b1a',
                textDecoration: 'none',
                borderRadius: '2px',
                padding: '0 1px',
              }}
            >
              {part.value}
            </ins>
          )
        }
        if (part.removed) {
          return (
            <del
              key={i}
              style={{
                background: '#ffd7d7',
                color: '#8b1a1a',
                textDecoration: 'line-through',
                borderRadius: '2px',
                padding: '0 1px',
              }}
            >
              {part.value}
            </del>
          )
        }
        return <span key={i}>{part.value}</span>
      })}
    </div>
  )
}

export default DiffViewer
