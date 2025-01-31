import React, { useCallback, useEffect } from 'react'
import styled from 'styled-components'
import { assertUnreachable } from '../../common/assert-unreachable'
import { RaceChar } from '../../common/races'
import Avatar from '../avatars/avatar'
import GithubIcon from '../icons/brands/github.svg'
import KofiIcon from '../icons/brands/kofi-lockup.svg'
import PatreonIcon from '../icons/brands/patreon-lockup.svg'
import { RaceIcon } from '../lobbies/race-icon'
import { TabItem, Tabs } from '../material/tabs'
import { goToIndex } from '../navigation/action-creators'
import { replace } from '../navigation/routing'
import { useAppSelector } from '../redux-hooks'
import {
  amberA400,
  backgroundSaturatedDark,
  backgroundSaturatedLight,
  blue400,
  colorTextFaint,
  colorTextInvert,
  colorTextPrimary,
  colorTextSecondary,
} from '../styles/colors'
import {
  caption,
  headline3,
  Headline5,
  headline6,
  overline,
  singleLine,
  Subtitle1,
  subtitle1,
  Subtitle2,
} from '../styles/typography'
import { correctUsernameForProfile, navigateToUserProfile } from './action-creators'
import { MatchHistory } from './match-history'
import { UserProfileSubPage } from './user-profile-sub-page'

const Container = styled.div`
  max-width: 960px;
  /* 18px + 6px from tab = 24px at top, 12px + 24px from tab = 36px from left */
  padding: 18px 12px 24px;
`

const TabArea = styled.div`
  width: 100%;
  max-width: 720px;
`

export interface ConnectedUserProfilePageProps {
  userId: number
  username: string
  subPage?: UserProfileSubPage
}

export function ConnectedUserProfilePage({
  userId,
  username: usernameFromRoute,
  subPage = UserProfileSubPage.Summary,
}: ConnectedUserProfilePageProps) {
  if (isNaN(userId)) {
    goToIndex(replace)
  }

  const user = useAppSelector(s => s.users.byId.get(userId))
  const onTabChange = useCallback(
    (tab: UserProfileSubPage) => {
      navigateToUserProfile(user!.id, user!.name, tab)
    },
    [user],
  )

  useEffect(() => {
    if (user && usernameFromRoute !== user.name) {
      correctUsernameForProfile(user.id, user.name, subPage)
    }
  }, [usernameFromRoute, user, subPage])

  if (!user) {
    // TODO(tec27): request the data
    return <span>oh no! no user data!</span>
  }

  return (
    <UserProfilePage
      userId={user.id}
      username={user.name}
      subPage={subPage}
      onTabChange={onTabChange}
    />
  )
}

export interface UserProfilePageProps {
  userId: number
  username: string
  subPage?: UserProfileSubPage
  onTabChange: (tab: UserProfileSubPage) => void
}

export function UserProfilePage({
  userId,
  username,
  subPage = UserProfileSubPage.Summary,
  onTabChange,
}: UserProfilePageProps) {
  let content: React.ReactNode
  switch (subPage) {
    case UserProfileSubPage.Summary:
      content = <SummaryPage username={username} />
      break

    case UserProfileSubPage.Stats:
    case UserProfileSubPage.MatchHistory:
    case UserProfileSubPage.Seasons:
      content = <ComingSoonPage />
      break

    default:
      content = assertUnreachable(subPage)
  }

  return (
    <Container>
      <TabArea>
        <Tabs activeTab={subPage} onChange={onTabChange}>
          <TabItem value={UserProfileSubPage.Summary} text='Summary' />
          <TabItem value={UserProfileSubPage.Stats} text='Stats' />
          <TabItem value={UserProfileSubPage.MatchHistory} text='Match history' />
          <TabItem value={UserProfileSubPage.Seasons} text='Seasons' />
        </Tabs>
      </TabArea>

      {content}
    </Container>
  )
}

const TopSection = styled.div`
  height: 100px;
  width: 100%;
  /* 34px + 6px from tab = 40px */
  margin-top: 34px;
  margin-bottom: 48px;
  padding: 0 24px;

  display: flex;
  align-items: center;
`

const AvatarCircle = styled.div`
  width: 100px;
  height: 100px;
  position: relative;

  background-color: ${backgroundSaturatedDark};
  border: 12px solid ${backgroundSaturatedLight};
  border-radius: 50%;
`

const StyledAvatar = styled(Avatar)`
  position: absolute;
  width: 56px;
  height: 56px;
  top: calc(50% - 28px);
  left: calc(50% - 28px);
`

const UsernameAndTitle = styled.div`
  flex-grow: 1;
  margin-left: 24px;
`

const Username = styled.div`
  ${headline3};
  ${singleLine};
  color: ${amberA400};
`

const RankInfo = styled.div`
  display: flex;
  flex-direction: column;
`

const RankInfoEntry = styled.div`
  display: flex;
  align-items: center;

  & + & {
    margin-top: 12px;
  }
`

const RankLabel = styled.div`
  ${overline};
  ${singleLine};

  width: 112px;
  margin-right: 12px;
  display: inline-block;

  color: ${colorTextSecondary};
  line-height: 28px;
  text-align: right;
`

const RankValue = styled.div<{ $background: 'accent' | 'primary' }>`
  ${subtitle1};
  height: 28px;
  padding: 0 12px;
  display: inline-block;

  background-color: ${props => (props.$background === 'accent' ? amberA400 : blue400)};
  border-radius: 4px;
  color: ${props => (props.$background === 'accent' ? colorTextInvert : colorTextPrimary)};
  line-height: 28px;
`

const SectionOverline = styled.div`
  ${overline};
  ${singleLine};
  color: ${colorTextFaint};
  margin: 12px 24px;
`

const TotalGamesSection = styled.div`
  padding: 0 24px;
  margin-bottom: 48px;

  display: flex;
  align-items: center;
`

const TotalGamesSpacer = styled.div`
  width: 8px;
  height: 1px;
  flex-grow: 1;
`

const EmptyListText = styled.div`
  ${subtitle1};
  margin: 0 24px;
  color: ${colorTextFaint};
`

function SummaryPage({ username }: { username: string }) {
  const title = 'Biggus Fannius'
  const mmr = 1698
  const rank = 1

  return (
    <>
      <TopSection>
        <AvatarCircle>
          <StyledAvatar username={username} />
        </AvatarCircle>
        <UsernameAndTitle>
          <Username>{username}</Username>
          <Subtitle2>{title}</Subtitle2>
        </UsernameAndTitle>
        <RankInfo>
          <RankInfoEntry>
            <RankLabel>Current MMR</RankLabel>
            <RankValue $background='accent'>{mmr}</RankValue>
          </RankInfoEntry>
          <RankInfoEntry>
            <RankLabel>Current Rank</RankLabel>
            <RankValue $background='primary'>{rank}</RankValue>
          </RankInfoEntry>
        </RankInfo>
      </TopSection>

      <SectionOverline>Total games</SectionOverline>
      <TotalGamesSection>
        <TotalGamesEntry race='t' wins={13925} losses={10664} />
        <TotalGamesSpacer />
        <TotalGamesEntry race='z' wins={2185} losses={3688} />
        <TotalGamesSpacer />
        <TotalGamesEntry race='p' wins={261} losses={83} />
      </TotalGamesSection>

      <SectionOverline>Latest games</SectionOverline>
      <MatchHistory />

      <SectionOverline>Achievements</SectionOverline>
      <EmptyListText>Nothing to see here</EmptyListText>
    </>
  )
}

const ComingSoonRoot = styled.div`
  /* 34px + 6px from tab = 40px */
  margin-top: 34px;
  padding: 0 24px;
`

const FundingSection = styled.div`
  margin-top: 48px;
`

const SupportLinks = styled.div`
  display: flex;
  align-items: flex-start;

  margin-top: 8px;
  /** Offset for the inner padding of the first item */
  margin-left: -16px;

  a,
  a:link,
  a:visited {
    height: 48px;
    display: flex;
    align-items: center;
    color: ${colorTextSecondary};
    padding-left: 16px;
    padding-right: 16px;
    overflow: hidden;

    &:hover,
    &:active {
      color: ${colorTextPrimary};
    }
  }
`
const StyledGithubIcon = styled(GithubIcon)`
  height: 40px;
`

const StyledKofiIcon = styled(KofiIcon)`
  height: 40px;
`

const StyledPatreonIcon = styled(PatreonIcon)`
  height: 24px;
`

function ComingSoonPage() {
  return (
    <ComingSoonRoot>
      <Headline5>This feature is coming soon!</Headline5>

      <FundingSection>
        <Subtitle1>Help fund ShieldBattery's development:</Subtitle1>
        <SupportLinks>
          <a
            href='https://github.com/sponsors/ShieldBattery'
            target='_blank'
            rel='noopener'
            title='GitHub Sponsors'>
            <StyledGithubIcon />
          </a>
          <a href='https://ko-fi.com/tec27' target='_blank' rel='noopener' title='Ko-fi'>
            <StyledKofiIcon />
          </a>
          <a href='https://patreon.com/tec27' target='_blank' rel='noopener' title='Patreon'>
            <StyledPatreonIcon />
          </a>
        </SupportLinks>
      </FundingSection>
    </ComingSoonRoot>
  )
}

const TotalGamesEntryRoot = styled.div`
  flex-shrink: 1;

  display: flex;
  align-items: center;
`

const RaceCircle = styled.div`
  width: 64px;
  height: 64px;
  flex-shrink: 0;
  position: relative;
  margin-right: 12px;

  background-color: ${backgroundSaturatedDark};
  border: 6px solid ${backgroundSaturatedLight};
  border-radius: 50%;
`

const RaceCircleIcon = styled(RaceIcon)`
  position: absolute;
  width: 40px;
  height: 40px;
  top: calc(50% - 20px);
  left: calc(50% - 20px);

  fill: ${colorTextPrimary};
`

const TotalGamesText = styled.div`
  ${headline6};
  ${singleLine};
`

const WinLossText = styled.div`
  ${caption};
  color: ${colorTextSecondary};
`

function TotalGamesEntry({ race, wins, losses }: { race: RaceChar; wins: number; losses: number }) {
  const winrate = Math.round((wins * 100 * 10) / (wins + losses)) / 10

  return (
    <TotalGamesEntryRoot>
      <RaceCircle>
        <RaceCircleIcon race={race} />
      </RaceCircle>
      <div>
        <TotalGamesText>{wins + losses}</TotalGamesText>
        <WinLossText>
          {wins} W – {losses} L – {winrate}%
        </WinLossText>
      </div>
    </TotalGamesEntryRoot>
  )
}
