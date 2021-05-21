import PropTypes from 'prop-types'
import React from 'react'
import styled from 'styled-components'
import { background700 } from '../../styles/colors'

const Footer = styled.div``

const Container = styled.nav`
  width: 256px;

  display: flex;
  flex-direction: column;
  flex-grow: 0;
  flex-shrink: 0;

  background-color: ${background700};
`

const Sections = styled.div`
  padding: 8px 0 0;
  flex-grow: 1;
  overflow-y: auto;
`

function LeftNav(props) {
  const footer = props.footer ? <Footer>{props.footer}</Footer> : undefined
  return (
    <Container>
      <Sections>{props.children}</Sections>
      {footer}
    </Container>
  )
}

LeftNav.propTypes = {
  footer: PropTypes.node,
}

export default LeftNav
