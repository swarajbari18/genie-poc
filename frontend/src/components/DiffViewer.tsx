import React from 'react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'

interface DiffViewerProps {
  oldText: string
  newText: string
  oldTitle?: string
  newTitle?: string
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  oldText,
  newText,
  oldTitle = 'Previous Version',
  newTitle = 'Returned Version',
}) => {
  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden bg-white">
      <ReactDiffViewer
        oldValue={oldText}
        newValue={newText}
        splitView={true}
        leftTitle={oldTitle}
        rightTitle={newTitle}
        compareMethod={DiffMethod.WORDS}
        styles={{
          variables: {
            light: {
              diffViewerBackground: '#fff',
              diffViewerColor: '#212529',
              addedBackground: '#e6ffed',
              addedColor: '#24292e',
              removedBackground: '#ffeef0',
              removedColor: '#24292e',
              wordAddedBackground: '#acf2bd',
              wordRemovedBackground: '#fdb8c0',
              addedGutterBackground: '#cdffd8',
              removedGutterBackground: '#ffdce0',
              gutterColor: '#959da5',
              codeFoldGutterBackground: '#f1f8ff',
              codeFoldBackground: '#f7f8fa',
              codeFoldContentColor: '#586069',
            },
          },
          line: {
            fontSize: '0.875rem',
            lineHeight: '1.5',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          },
        }}
      />
    </div>
  )
}

export default DiffViewer
